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
    cfg_fp: HashMap<String, String>,   // channel -> config fingerprint (for hot-reload)
}

static REG: Lazy<Mutex<Registry>> = Lazy::new(|| {
    Mutex::new(Registry {
        status: HashMap::new(),
        tasks: HashMap::new(),
        rate: HashMap::new(),
        cfg_fp: HashMap::new(),
    })
});

/// Exponential backoff with jitter for connector reconnect loops. Starts at 1s,
/// doubles per failure up to a 60s cap, with ±20% jitter so connectors (or
/// multiple app instances) don't reconnect in lockstep and hammer an endpoint
/// during an outage (review M2). Call `reset()` after a successful cycle.
pub struct Backoff {
    attempt: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self { attempt: 0 }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Sleep for the current backoff interval, then advance toward the cap.
    pub async fn sleep(&mut self) {
        const BASE_MS: u64 = 1000;
        const CAP_MS: u64 = 60_000;
        let shift = self.attempt.min(6);
        let capped = BASE_MS.saturating_mul(1u64 << shift).min(CAP_MS);
        // ±20% jitter via a single best-effort random byte.
        let mut b = [0u8; 1];
        let frac = if getrandom::getrandom(&mut b).is_ok() {
            b[0] as u64
        } else {
            128
        };
        let span = capped / 5; // 20%
        let delay = capped.saturating_sub(span) + (span * 2 * frac / 255);
        if self.attempt < 6 {
            self.attempt += 1;
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
}

/// Validate + normalize a user-configured server base URL (Matrix homeserver,
/// Mattermost server). Rejects plaintext `http://` to a non-localhost host —
/// that would send the bearer token in clear and invites trivial SSRF to
/// internal services (review M7). A bare host with no scheme is assumed https.
/// Returns the trimmed base with any trailing '/' removed.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let t = raw.trim().trim_end_matches('/');
    if t.is_empty() {
        return Err("empty server url".into());
    }
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        let is_local = host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.ends_with(".localhost");
        if !is_local {
            return Err(format!(
                "refusing plaintext http:// to '{host}' — use https:// (http is only allowed to localhost)"
            ));
        }
    }
    Ok(t.to_string())
}

/// Fingerprint a channel's effective config (token + allowlist + non-secret
/// fields) so `start()` can detect that a running channel's settings changed and
/// respawn it with the new config instead of no-oping (review M1 — an edited
/// allowlist must take effect without a manual stop/start). The token is
/// SHA-256'd, never retained in the clear.
fn cfg_fingerprint(token: &str, allowed: &HashSet<String>, fields: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut ids: Vec<&str> = allowed.iter().map(String::as_str).collect();
    ids.sort_unstable();
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    h.update([0u8]);
    for id in ids {
        h.update(id.as_bytes());
        h.update([0u8]);
    }
    h.update(serde_json::to_vec(fields).unwrap_or_default());
    format!("{:x}", h.finalize())
}

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
    // Bound the map: evict windows older than the rate window so it can't grow
    // O(every sender ever) over the life of a long-running desktop process
    // (review H1/H2). Only sweeps when the map is non-trivially large.
    if r.rate.len() > 256 {
        r.rate.retain(|_, (start, _)| now - *start < RATE_WINDOW_SECS);
    }
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
    // Read config + validate BEFORE taking the registry lock (no shared state).
    let (token, allowed, fields) = channel_config(channel)?;
    if allowed.is_empty() {
        return Err(format!(
            "Refusing to start {channel}: the allowed-sender list is empty. Add at least one allowed sender first — an empty allowlist would let anyone who finds the bot control your agent."
        ));
    }
    let allowed_count = allowed.len();
    let fp = cfg_fingerprint(&token, &allowed, &fields);
    let ctx = GwCtx {
        app: app.clone(),
        channel: channel.to_string(),
        token,
        allowed,
        fields,
    };
    let ch = channel.to_string();
    // ATOMIC (review C1/M1): hold the registry lock ONCE across the
    // liveness re-check + status-insert + spawn + handle-insert, so two
    // concurrent start()s (UI double-click) can't both pass the check and
    // orphan a task, and no status() can observe running=true with no task.
    // tokio::spawn is synchronous (schedules, doesn't await), so holding the
    // parking_lot lock across it is safe — no await under the lock.
    let mut r = REG.lock();
    let alive = r
        .tasks
        .get(channel)
        .map(|t| !t.is_finished())
        .unwrap_or(false);
    if alive {
        if r.cfg_fp.get(channel).map(|f| f == &fp).unwrap_or(false) {
            return Ok(()); // already running with the same config
        }
        // Config changed (allowlist / token / fields edited) — abort the stale
        // task so the new config takes effect (review M1). The frontend re-calls
        // start() whenever settings change, so this is the hot-reload path.
        if let Some(t) = r.tasks.remove(channel) {
            t.abort();
        }
    }
    r.cfg_fp.insert(channel.to_string(), fp);
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
    r.tasks.insert(channel.to_string(), handle);
    Ok(())
}

/// Persist/load a connector's poll cursor (Matrix `since`, Telegram `offset`)
/// so a task restart doesn't replay old history or reset to the beginning
/// (review M6). Stored next to settings; best-effort (errors ignored).
pub fn cursor_path(channel: &str) -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join(format!("Froglips/messaging-{channel}.cursor")))
}
pub fn load_cursor(channel: &str) -> Option<String> {
    let p = cursor_path(channel)?;
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
pub fn save_cursor(channel: &str, cursor: &str) {
    if let Some(p) = cursor_path(channel) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, cursor);
    }
}

pub fn stop(channel: &str) {
    let mut r = REG.lock();
    if let Some(t) = r.tasks.remove(channel) {
        t.abort();
    }
    r.cfg_fp.remove(channel);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_rejects_plaintext_to_remote() {
        // https + bare host (assumed https) are fine.
        assert_eq!(
            normalize_base_url("https://matrix.org/").unwrap(),
            "https://matrix.org"
        );
        assert_eq!(
            normalize_base_url("chat.example.com").unwrap(),
            "chat.example.com"
        );
        // http to a non-localhost host is refused (token would go in clear).
        assert!(normalize_base_url("http://matrix.example.com").is_err());
        assert!(normalize_base_url("http://10.0.0.5:8065").is_err());
        // http to localhost is allowed (dev / self-hosted on the same box).
        assert!(normalize_base_url("http://localhost:8065").is_ok());
        assert!(normalize_base_url("http://127.0.0.1:8008").is_ok());
        assert!(normalize_base_url("   ").is_err());
    }

    #[test]
    fn cfg_fingerprint_changes_when_allowlist_changes() {
        let fields = Value::Null;
        let a: HashSet<String> = ["123".to_string()].into_iter().collect();
        let b: HashSet<String> = ["123".to_string(), "456".to_string()].into_iter().collect();
        let fp_a = cfg_fingerprint("tok", &a, &fields);
        let fp_b = cfg_fingerprint("tok", &b, &fields);
        assert_ne!(fp_a, fp_b, "adding an allowed sender must change the fingerprint");
        // Stable across set ordering / re-computation.
        let a2: HashSet<String> = ["123".to_string()].into_iter().collect();
        assert_eq!(fp_a, cfg_fingerprint("tok", &a2, &fields));
        // Token change is detected too.
        assert_ne!(fp_a, cfg_fingerprint("tok2", &a, &fields));
    }

    #[test]
    fn chunk_splits_on_char_boundaries_within_limit() {
        // Short text is one chunk.
        assert_eq!(chunk("hello", 10), vec!["hello".to_string()]);
        // Multibyte chars never exceed the char limit and round-trip intact.
        let s = "héllo wörld ".repeat(20);
        let parts = chunk(&s, 8);
        assert!(parts.iter().all(|p| p.chars().count() <= 8));
        assert_eq!(parts.concat(), s);
    }
}
