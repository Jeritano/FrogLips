//! Mattermost connector — WebSocket event stream + REST posts (self-hosted).
//!
//! Connects to `{server}/api/v4/websocket` (wss/ws), authenticates with the bot
//! access token, and listens for `posted` events. The bot's own posts are
//! skipped (compared against `/users/me`). Replies go back via REST
//! `POST /api/v4/posts`.

use super::{accept, chunk, emit, set_error, set_username, GwCtx};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const MAX_CHARS: usize = 14000;

/// Normalize the configured server URL to a scheme://host[:port] base with no
/// trailing slash and no path.
fn server_base(fields: &Value) -> Result<String, String> {
    let raw = fields
        .get("server_url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "no server_url configured".to_string())?;
    // Reject plaintext http:// to a non-localhost server (review M7).
    super::normalize_base_url(raw)
}

/// Derive the WebSocket URL (`/api/v4/websocket`) from the HTTP server base.
fn websocket_url(base: &str) -> String {
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        // No scheme given — assume TLS.
        format!("wss://{base}")
    };
    format!("{ws_base}/api/v4/websocket")
}

/// GET /api/v4/users/me with the bot token; returns the parsed user object.
async fn fetch_me(base: &str, token: &str) -> Result<Value, String> {
    if token.trim().is_empty() {
        return Err("no token stored".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{base}/api/v4/users/me"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("users/me failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("users/me {code}: {body}"));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn validate(token: &str, fields: &Value) -> Result<String, String> {
    let base = server_base(fields)?;
    let me = fetch_me(&base, token).await?;
    Ok(me
        .get("username")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("bot")
        .to_string())
}

pub async fn run(ctx: GwCtx) {
    let base = match server_base(&ctx.fields) {
        Ok(b) => b,
        Err(e) => {
            set_error("mattermost", Some(e));
            // No valid config — idle until the task is aborted.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
        }
    };

    // One-time identity lookup so we can ignore the bot's own posts.
    let mut bot_user_id = String::new();
    match fetch_me(&base, &ctx.token).await {
        Ok(me) => {
            if let Some(name) = me.get("username").and_then(|s| s.as_str()) {
                set_username("mattermost", Some(name.to_string()));
            }
            if let Some(id) = me.get("id").and_then(|s| s.as_str()) {
                bot_user_id = id.to_string();
            }
        }
        Err(e) => {
            // Surface the error but still try to connect — re-fetch in loop.
            set_error("mattermost", Some(e));
        }
    }

    let ws_url = websocket_url(&base);
    // Per-process monotonic sequence id for outgoing WS actions (not reset per
    // connection). A u64 at this rate is not expected to wrap.
    let mut seq: u64 = 1;
    let mut backoff = super::Backoff::new();

    loop {
        // Refresh identity if we still don't have a bot id.
        if bot_user_id.is_empty() {
            if let Ok(me) = fetch_me(&base, &ctx.token).await {
                if let Some(name) = me.get("username").and_then(|s| s.as_str()) {
                    set_username("mattermost", Some(name.to_string()));
                }
                if let Some(id) = me.get("id").and_then(|s| s.as_str()) {
                    bot_user_id = id.to_string();
                }
            }
        }

        let mut stream = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((s, _resp)) => s,
            Err(e) => {
                set_error("mattermost", Some(format!("connect failed: {e}")));
                backoff.sleep().await;
                continue;
            }
        };

        // Authentication challenge.
        let auth = serde_json::json!({
            "seq": seq,
            "action": "authentication_challenge",
            "data": { "token": ctx.token },
        });
        seq += 1;
        if let Err(e) = stream.send(Message::Text(auth.to_string())).await {
            set_error("mattermost", Some(format!("auth send failed: {e}")));
            backoff.sleep().await;
            continue;
        }

        set_error("mattermost", None);
        backoff.reset();

        // Read events until the socket drops, then reconnect.
        // Bound each read so a stale-but-open socket can't hang the task
        // forever; on timeout, break and let the loop re-establish the socket.
        loop {
            let frame = match tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
                Ok(Some(frame)) => frame,
                // Stream ended.
                Ok(None) => break,
                // No traffic for 60s — assume the socket is stale; reconnect.
                Err(_) => {
                    set_error("mattermost", Some("read timeout".into()));
                    break;
                }
            };
            let msg = match frame {
                Ok(m) => m,
                Err(e) => {
                    set_error("mattermost", Some(format!("read error: {e}")));
                    break;
                }
            };
            let payload = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => match String::from_utf8(b) {
                    Ok(s) => s,
                    Err(_) => continue,
                },
                Message::Ping(p) => {
                    let _ = stream.send(Message::Pong(p)).await;
                    continue;
                }
                Message::Close(_) => {
                    set_error("mattermost", Some("server closed connection".into()));
                    break;
                }
                _ => continue,
            };

            let event: Value = match serde_json::from_str(&payload) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if event.get("event").and_then(|s| s.as_str()) != Some("posted") {
                continue;
            }

            // `data.post` is a JSON-encoded STRING — parse it.
            let Some(post_str) = event.pointer("/data/post").and_then(|s| s.as_str()) else {
                continue;
            };
            let post: Value = match serde_json::from_str(post_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let user_id = post
                .get("user_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let channel_id = post
                .get("channel_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let message = post
                .get("message")
                .and_then(|s| s.as_str())
                .unwrap_or("");

            if user_id.is_empty() || channel_id.is_empty() || message.is_empty() {
                continue;
            }
            // Fail closed (review H2): if we never resolved our own user id we
            // can't rule out an echo loop, so don't act. Also skip own posts.
            if bot_user_id.is_empty() || user_id == bot_user_id {
                continue;
            }
            if !accept(&ctx, &user_id) {
                continue;
            }
            emit(&ctx, &channel_id, &user_id, &user_id, message);
        }

        // Socket closed — back off (exponential, review M2) and reconnect.
        backoff.sleep().await;
    }
}

pub async fn send(token: &str, fields: &Value, target: &str, text: &str) -> Result<(), String> {
    let base = server_base(fields)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{base}/api/v4/posts");
    for part in chunk(text, MAX_CHARS) {
        let resp = client
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({ "channel_id": target, "message": part }))
            .send()
            .await
            .map_err(|e| format!("create post failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            return Err(format!(
                "create post {code}: {}",
                resp.text().await.unwrap_or_default()
            ));
        }
    }
    Ok(())
}
