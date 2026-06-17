//! Messaging gateway — run the Froglips agent over chat platforms (v1: Telegram).
//!
//! Architecture: this module owns the platform I/O only. A background tokio task
//! long-polls Telegram `getUpdates`, filters by the allowed-sender allowlist +
//! a per-sender rate limit, and emits an `messaging://inbound` Tauri event for
//! each accepted message. The FRONTEND runs the actual agent loop (so it reuses
//! the full tool-calling agent) under a locked safe-tools-only policy, then calls
//! `messaging_send` to deliver the reply. The agent never runs here.
//!
//! SAFETY (this is a remote-input -> local-agent door):
//!   * The gateway REFUSES to start with an empty allowlist — an empty list would
//!     let anyone who finds the bot drive the agent. Fail closed.
//!   * Every inbound message is allowlist-checked HERE before it is emitted, and
//!     re-checked frontend-side. Non-allowlisted senders are dropped silently.
//!   * Per-sender rate limit bounds abuse.
//!   * The bot token lives in the Keychain, never in settings.json or events.
//!
//! The loop is cancellable: `stop()` aborts the task at its next await (the
//! long-poll request), so toggling the channel off takes effect within ~the
//! poll timeout.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

/// Telegram hard limit on a single sendMessage text (UTF-16 code units; we treat
/// it as chars conservatively and split well under it).
const TG_MAX_CHARS: usize = 3800;
/// Per-sender rate limit: messages allowed per rolling window.
const RATE_MAX: u32 = 20;
const RATE_WINDOW_SECS: i64 = 60;

#[derive(Clone, Serialize, Default)]
pub struct GatewayStatus {
    pub running: bool,
    pub channel: String,
    pub bot_username: Option<String>,
    pub last_error: Option<String>,
    pub started_at: i64,
    pub messages_accepted: u64,
    pub messages_blocked: u64,
    pub allowed_count: usize,
}

struct GwInner {
    status: GatewayStatus,
    task: Option<JoinHandle<()>>,
    /// per-sender rolling-window counters for rate limiting.
    rate: HashMap<i64, (i64, u32)>,
}

static GW: Lazy<Mutex<GwInner>> = Lazy::new(|| {
    Mutex::new(GwInner {
        status: GatewayStatus {
            channel: "telegram".into(),
            ..Default::default()
        },
        task: None,
        rate: HashMap::new(),
    })
});

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Inbound message emitted to the frontend. camelCase for JS ergonomics.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Inbound {
    channel: String,
    chat_id: i64,
    message_id: i64,
    sender_id: i64,
    sender_name: String,
    text: String,
}

pub fn status() -> GatewayStatus {
    GW.lock().status.clone()
}

/// True if the running task is still alive.
fn task_alive() -> bool {
    let g = GW.lock();
    g.task.as_ref().map(|t| !t.is_finished()).unwrap_or(false)
}

/// Validate a bot token via getMe; returns the bot username on success.
pub async fn validate_token(token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("getMe request failed: {e}"))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        let name = v
            .pointer("/result/username")
            .and_then(|s| s.as_str())
            .unwrap_or("bot")
            .to_string();
        Ok(name)
    } else {
        Err(v
            .get("description")
            .and_then(|s| s.as_str())
            .unwrap_or("invalid token")
            .to_string())
    }
}

/// Start the Telegram gateway. `allowed` is the non-empty allowlist of numeric
/// sender IDs (as strings). Errors (fail closed) on empty allowlist or already
/// running.
pub async fn start(app: AppHandle, token: String, allowed: Vec<String>) -> Result<(), String> {
    if allowed.is_empty() {
        return Err("Refusing to start: the Allowed user IDs list is empty. Add at least one numeric Telegram user ID (from @userinfobot) first — an empty allowlist would let anyone who finds the bot control your agent.".into());
    }
    if task_alive() {
        return Ok(()); // already running
    }
    // Validate up front so a bad token surfaces immediately instead of looping.
    let username = validate_token(&token).await?;

    let allowed_set: std::collections::HashSet<i64> =
        allowed.iter().filter_map(|s| s.trim().parse::<i64>().ok()).collect();
    if allowed_set.is_empty() {
        return Err("Allowed user IDs must be numeric Telegram IDs (e.g. 123456789).".into());
    }
    let allowed_count = allowed_set.len();

    let app2 = app.clone();
    let handle = tokio::spawn(async move {
        run_loop(app2, token, allowed_set).await;
    });

    let mut g = GW.lock();
    g.task = Some(handle);
    g.rate.clear();
    g.status = GatewayStatus {
        running: true,
        channel: "telegram".into(),
        bot_username: Some(username),
        last_error: None,
        started_at: now_unix(),
        messages_accepted: 0,
        messages_blocked: 0,
        allowed_count,
    };
    Ok(())
}

pub fn stop() {
    let mut g = GW.lock();
    if let Some(t) = g.task.take() {
        t.abort();
    }
    g.status.running = false;
    g.rate.clear();
}

/// Rate-limit gate for a sender. Returns true if the message is allowed.
fn rate_ok(sender: i64) -> bool {
    let now = now_unix();
    let mut g = GW.lock();
    let e = g.rate.entry(sender).or_insert((now, 0));
    if now - e.0 >= RATE_WINDOW_SECS {
        *e = (now, 0);
    }
    if e.1 >= RATE_MAX {
        return false;
    }
    e.1 += 1;
    true
}

async fn run_loop(app: AppHandle, token: String, allowed: std::collections::HashSet<i64>) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            GW.lock().status.last_error = Some(format!("client build failed: {e}"));
            return;
        }
    };
    let mut offset: i64 = 0;
    loop {
        let url = format!(
            "https://api.telegram.org/bot{token}/getUpdates?timeout=25&offset={offset}&allowed_updates=%5B%22message%22%5D"
        );
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                GW.lock().status.last_error = Some(format!("poll error: {e}"));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        let v: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                GW.lock().status.last_error = Some(format!("decode error: {e}"));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            GW.lock().status.last_error = v
                .get("description")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }
        GW.lock().status.last_error = None;
        let Some(updates) = v.get("result").and_then(|r| r.as_array()) else {
            continue;
        };
        for upd in updates {
            if let Some(uid) = upd.get("update_id").and_then(|n| n.as_i64()) {
                offset = uid + 1;
            }
            let Some(msg) = upd.get("message") else { continue };
            let Some(text) = msg.get("text").and_then(|s| s.as_str()) else {
                continue;
            };
            let sender_id = msg.pointer("/from/id").and_then(|n| n.as_i64()).unwrap_or(0);
            let chat_id = msg.pointer("/chat/id").and_then(|n| n.as_i64()).unwrap_or(0);
            let message_id = msg.get("message_id").and_then(|n| n.as_i64()).unwrap_or(0);
            // ── Safety gate: allowlist ──
            if !allowed.contains(&sender_id) {
                GW.lock().status.messages_blocked += 1;
                continue;
            }
            if !rate_ok(sender_id) {
                GW.lock().status.messages_blocked += 1;
                continue;
            }
            let sender_name = msg
                .pointer("/from/first_name")
                .and_then(|s| s.as_str())
                .or_else(|| msg.pointer("/from/username").and_then(|s| s.as_str()))
                .unwrap_or("user")
                .to_string();
            GW.lock().status.messages_accepted += 1;
            let _ = app.emit(
                "messaging://inbound",
                Inbound {
                    channel: "telegram".into(),
                    chat_id,
                    message_id,
                    sender_id,
                    sender_name,
                    text: text.to_string(),
                },
            );
        }
    }
}

/// Send a reply to a Telegram chat, chunked under the platform limit. Token is
/// read from the Keychain so the renderer never handles it.
pub async fn send(token: &str, chat_id: i64, text: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    for chunk in chunk_text(text, TG_MAX_CHARS) {
        let body = serde_json::json!({ "chat_id": chat_id, "text": chunk });
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("sendMessage failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            let detail = resp.text().await.unwrap_or_default();
            return Err(format!("sendMessage {code}: {detail}"));
        }
    }
    Ok(())
}

/// Split text into <=`max`-char chunks on char boundaries (prefer newline).
fn chunk_text(text: &str, max: usize) -> Vec<String> {
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
            // A single oversized line: hard-split by chars.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_short_is_single() {
        assert_eq!(chunk_text("hello", 100), vec!["hello".to_string()]);
    }

    #[test]
    fn chunk_splits_long() {
        let s = "a".repeat(50);
        let parts = chunk_text(&s, 20);
        assert!(parts.len() >= 3);
        assert_eq!(parts.concat().len(), 50);
        assert!(parts.iter().all(|p| p.chars().count() <= 20));
    }

    #[test]
    fn chunk_prefers_newlines() {
        let s = format!("{}\n{}", "x".repeat(15), "y".repeat(15));
        let parts = chunk_text(&s, 20);
        // First chunk should break at the newline rather than mid-line.
        assert!(parts[0].ends_with('\n') || parts[0].chars().count() <= 16);
    }
}
