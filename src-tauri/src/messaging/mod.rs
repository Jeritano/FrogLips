//! Messaging gateway — run the Froglips agent over chat platforms.
//!
//! Multi-channel: each enabled channel runs its own cancellable tokio task that
//! produces `messaging://inbound` events; the FRONTEND runs the agent (under a
//! read-only safe-tools policy) and replies via `messaging_send`, which this
//! module routes to the right platform. Connectors live in sibling files
//! (telegram/matrix/discord/slack/mattermost/email) and only do platform I/O.
//!
//! SAFETY (remote input -> local agent): every connector funnels inbound through
//! `accept()` here, which enforces the per-channel allowed-sender allowlist + a
//! per-sender rate limit before anything is emitted. The gateway refuses to
//! start a channel with an empty allowlist (fail closed). Secrets (bot tokens /
//! passwords) live in the Keychain (`messaging:<channel>`), never in events or
//! settings.

mod discord;
mod email;
mod matrix;
mod mattermost;
mod slack;
mod telegram;

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

const RATE_MAX: u32 = 20;
const RATE_WINDOW_SECS: i64 = 60;

/// The channels the gateway knows how to run.
pub const CHANNELS: &[&str] = &[
    "telegram",
    "matrix",
    "discord",
    "slack",
    "mattermost",
    "email",
];

#[derive(Clone, Serialize, Default)]
pub struct ChannelStatus {
    pub channel: String,
    pub running: bool,
    pub bot_username: Option<String>,
    pub last_error: Option<String>,
    pub started_at: i64,
    pub messages_accepted: u64,
    pub messages_blocked: u64,
    pub allowed_count: usize,
}

struct Registry {
    status: HashMap<String, ChannelStatus>,
    tasks: HashMap<String, JoinHandle<()>>,
    rate: HashMap<String, (i64, u32)>, // key "channel:sender" -> (window_start, count)
}

static REG: Lazy<Mutex<Registry>> = Lazy::new(|| {
    Mutex::new(Registry {
        status: HashMap::new(),
        tasks: HashMap::new(),
        rate: HashMap::new(),
    })
});

/// Split text into <=`max`-char chunks on char boundaries (prefer newline).
/// Shared by connectors whose platforms cap message length.
pub fn chunk(text: &str, max: usize) -> Vec<String> {
    if text.chars().count() <= max {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in text.split_inclusive('\n') {
        if cur.chars().count() + line.chars().count() > max {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            if line.chars().count() > max {
                let mut piece = String::new();
                for ch in line.chars() {
                    if piece.chars().count() >= max {
                        out.push(std::mem::take(&mut piece));
                    }
                    piece.push(ch);
                }
                if !piece.is_empty() {
                    cur = piece;
                }
                continue;
            }
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Context handed to a connector's `run`: the platform secret, the allowlist,
/// and the channel-specific non-secret config (urls/hosts) as JSON.
pub struct GwCtx {
    pub app: AppHandle,
    pub channel: String,
    pub token: String,
    pub allowed: HashSet<String>,
    pub fields: Value,
}

/// Inbound message emitted to the frontend (camelCase for JS). `target` is the
/// opaque reply destination the connector will route a `send` back to.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Inbound {
    channel: String,
    target: String,
    sender: String,
    sender_name: String,
    text: String,
}

/// Allowlist + rate-limit gate. Connectors MUST call this before emitting; it
/// returns true only for an allowed, non-rate-limited sender, and updates the
/// blocked/accepted counters either way.
pub fn accept(ctx: &GwCtx, sender: &str) -> bool {
    if !ctx.allowed.contains(sender) {
        bump_blocked(&ctx.channel);
        return false;
    }
    let now = now_unix();
    let key = format!("{}:{}", ctx.channel, sender);
    let mut r = REG.lock();
    let e = r.rate.entry(key).or_insert((now, 0));
    if now - e.0 >= RATE_WINDOW_SECS {
        *e = (now, 0);
    }
    if e.1 >= RATE_MAX {
        drop(r);
        bump_blocked(&ctx.channel);
        return false;
    }
    e.1 += 1;
    true
}

/// Emit an accepted inbound message + bump the accepted counter.
pub fn emit(ctx: &GwCtx, target: &str, sender: &str, sender_name: &str, text: &str) {
    if let Some(s) = REG.lock().status.get_mut(&ctx.channel) {
        s.messages_accepted += 1;
    }
    let _ = ctx.app.emit(
        "messaging://inbound",
        Inbound {
            channel: ctx.channel.clone(),
            target: target.to_string(),
            sender: sender.to_string(),
            sender_name: sender_name.to_string(),
            text: text.to_string(),
        },
    );
}

fn bump_blocked(channel: &str) {
    if let Some(s) = REG.lock().status.get_mut(channel) {
        s.messages_blocked += 1;
    }
}

pub fn set_error(channel: &str, err: Option<String>) {
    if let Some(s) = REG.lock().status.get_mut(channel) {
        s.last_error = err;
    }
}

pub fn set_username(channel: &str, name: Option<String>) {
    if let Some(s) = REG.lock().status.get_mut(channel) {
        s.bot_username = name;
    }
}

pub fn status() -> Vec<ChannelStatus> {
    let r = REG.lock();
    // Reconcile running flag against task liveness.
    r.status
        .values()
        .map(|s| {
            let alive = r
                .tasks
                .get(&s.channel)
                .map(|t| !t.is_finished())
                .unwrap_or(false);
            ChannelStatus {
                running: s.running && alive,
                ..s.clone()
            }
        })
        .collect()
}

fn task_alive(channel: &str) -> bool {
    REG.lock()
        .tasks
        .get(channel)
        .map(|t| !t.is_finished())
        .unwrap_or(false)
}

/// Pull (token, allowed, fields) for a channel from Keychain + settings.
fn channel_config(channel: &str) -> Result<(String, HashSet<String>, Value), String> {
    let kc = format!("messaging:{channel}");
    let token = crate::settings::keychain_get(&kc).unwrap_or_default();
    let m = crate::settings::load().messaging;
    let raw = serde_json::to_value(&m).unwrap_or(Value::Null);
    let chan = raw.get(channel).cloned().unwrap_or(Value::Null);
    let allowed: HashSet<String> = chan
        .get("allowed_user_ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Ok((token, allowed, chan))
}

/// Start a channel's gateway. Fails closed on empty allowlist.
pub async fn start(app: AppHandle, channel: &str) -> Result<(), String> {
    if !CHANNELS.contains(&channel) {
        return Err(format!("unknown channel: {channel}"));
    }
    if task_alive(channel) {
        return Ok(());
    }
    let (token, allowed, fields) = channel_config(channel)?;
    if allowed.is_empty() {
        return Err(format!(
            "Refusing to start {channel}: the allowed-sender list is empty. Add at least one allowed sender first — an empty allowlist would let anyone who finds the bot control your agent."
        ));
    }
    let allowed_count = allowed.len();
    let ctx = GwCtx {
        app: app.clone(),
        channel: channel.to_string(),
        token,
        allowed,
        fields,
    };
    // Pre-seed status so connectors can write errors immediately.
    {
        let mut r = REG.lock();
        r.status.insert(
            channel.to_string(),
            ChannelStatus {
                channel: channel.to_string(),
                running: true,
                started_at: now_unix(),
                allowed_count,
                ..Default::default()
            },
        );
    }
    let ch = channel.to_string();
    let handle = tokio::spawn(async move {
        match ch.as_str() {
            "telegram" => telegram::run(ctx).await,
            "matrix" => matrix::run(ctx).await,
            "discord" => discord::run(ctx).await,
            "slack" => slack::run(ctx).await,
            "mattermost" => mattermost::run(ctx).await,
            "email" => email::run(ctx).await,
            _ => {}
        }
    });
    REG.lock().tasks.insert(channel.to_string(), handle);
    Ok(())
}

pub fn stop(channel: &str) {
    let mut r = REG.lock();
    if let Some(t) = r.tasks.remove(channel) {
        t.abort();
    }
    if let Some(s) = r.status.get_mut(channel) {
        s.running = false;
    }
}

/// Stop every running channel. Reserved for an app-shutdown hook; tasks also die
/// with the process. `#[allow(dead_code)]` until that hook is wired.
#[allow(dead_code)]
pub fn stop_all() {
    let channels: Vec<String> = REG.lock().tasks.keys().cloned().collect();
    for c in channels {
        stop(&c);
    }
}

/// Validate a channel's stored credentials. Returns a human label (e.g. bot
/// username) on success.
pub async fn validate(channel: &str) -> Result<String, String> {
    let (token, _allowed, fields) = channel_config(channel)?;
    match channel {
        "telegram" => telegram::validate(&token).await,
        "matrix" => matrix::validate(&token, &fields).await,
        "discord" => discord::validate(&token).await,
        "slack" => slack::validate(&token, &fields).await,
        "mattermost" => mattermost::validate(&token, &fields).await,
        "email" => email::validate(&token, &fields).await,
        _ => Err(format!("unknown channel: {channel}")),
    }
}

/// Route an agent reply back to the originating platform.
pub async fn send(channel: &str, target: &str, text: &str) -> Result<(), String> {
    let (token, _allowed, fields) = channel_config(channel)?;
    match channel {
        "telegram" => telegram::send(&token, &fields, target, text).await,
        "matrix" => matrix::send(&token, &fields, target, text).await,
        "discord" => discord::send(&token, &fields, target, text).await,
        "slack" => slack::send(&token, &fields, target, text).await,
        "mattermost" => mattermost::send(&token, &fields, target, text).await,
        "email" => email::send(&token, &fields, target, text).await,
        _ => Err(format!("unknown channel: {channel}")),
    }
}
