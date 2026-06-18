//! Discord connector — Gateway WebSocket (gateway intents) + REST send.

use super::{accept, chunk, emit, set_error, set_username, GwCtx};
use futures::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const MAX_CHARS: usize = 1900;
const API: &str = "https://discord.com/api/v10";
// GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096) | MESSAGE_CONTENT (32768) = 37376
const INTENTS: u64 = 37376;

// Shared REST client for send() — built once and reused across calls.
static SEND_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("failed to build discord send client")
});

pub async fn validate(token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("no token stored".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{API}/users/@me"))
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .map_err(|e| format!("users/@me failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        return Err(format!(
            "users/@me {code}: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("username")
        .and_then(|s| s.as_str())
        .unwrap_or("bot")
        .to_string())
}

pub async fn run(ctx: GwCtx) {
    if let Ok(name) = validate(&ctx.token).await {
        set_username("discord", Some(name));
    }
    // Reconnect loop: re-run the entire connect/identify on any socket close.
    let mut backoff = super::Backoff::new();
    loop {
        let started = std::time::Instant::now();
        if let Err(e) = run_once(&ctx).await {
            set_error("discord", Some(e));
        }
        // A connection that lasted a while was healthy — reset so a later
        // transient drop reconnects fast; otherwise grow the delay so a revoked
        // token / persistent failure can't hammer the gateway (review M2).
        if started.elapsed() >= std::time::Duration::from_secs(60) {
            backoff.reset();
        }
        backoff.sleep().await;
    }
}

async fn run_once(ctx: &GwCtx) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Discover the gateway URL.
    let gw: Value = client
        .get(format!("{API}/gateway"))
        .send()
        .await
        .map_err(|e| format!("gateway lookup failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let base = gw
        .get("url")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "gateway url missing".to_string())?;
    let url = format!("{base}/?v=10&encoding=json");

    let (ws_stream, _resp) = connect_async(&url)
        .await
        .map_err(|e| format!("ws connect failed: {e}"))?;
    let (write, mut read) = ws_stream.split();
    let writer = Arc::new(AsyncMutex::new(write));

    // Shared last-seen sequence number; the heartbeat task sends it in op 1.
    let last_seq: Arc<AsyncMutex<Option<i64>>> = Arc::new(AsyncMutex::new(None));
    let mut hb_task: Option<tokio::task::JoinHandle<()>> = None;
    // Liveness flag for the heartbeat task: it flips this to false when it exits
    // (send failure, break, or panic) so the read loop can reconnect immediately
    // instead of waiting ~45s for the server's close frame.
    let hb_alive: Arc<AtomicBool> = Arc::new(AtomicBool::new(true));
    let mut identified = false;

    set_error("discord", None);

    loop {
        // Bound the read so a silent-but-open (zombie) socket that stops sending
        // events AND heartbeat ACKs is detected instead of parking forever; the
        // gateway heartbeats well under this window in normal operation.
        let frame =
            match tokio::time::timeout(std::time::Duration::from_secs(90), read.next()).await {
                Ok(Some(f)) => f,
                Ok(None) => break, // stream ended
                Err(_) => {
                    if let Some(h) = hb_task.take() {
                        h.abort();
                    }
                    return Err("read timeout (no gateway traffic)".to_string());
                }
            };
        // If the heartbeat task has died, the connection is effectively dead —
        // reconnect now rather than waiting for the server's close frame.
        if !hb_alive.load(Ordering::Relaxed) {
            if let Some(h) = hb_task.take() {
                h.abort();
            }
            return Err("heartbeat task stopped".to_string());
        }
        let msg = match frame {
            Ok(m) => m,
            Err(e) => {
                if let Some(h) = hb_task.take() {
                    h.abort();
                }
                return Err(format!("ws read error: {e}"));
            }
        };
        let txt = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Ping(p) => {
                let mut w = writer.lock().await;
                let _ = w.send(Message::Pong(p)).await;
                continue;
            }
            Message::Close(_) => {
                if let Some(h) = hb_task.take() {
                    h.abort();
                }
                return Err("ws closed by server".to_string());
            }
            _ => continue,
        };

        let payload: Value = match serde_json::from_str(&txt) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Track sequence number from every payload (op 0 carries `s`).
        if let Some(s) = payload.get("s").and_then(|n| n.as_i64()) {
            *last_seq.lock().await = Some(s);
        }

        let op = payload.get("op").and_then(|n| n.as_i64()).unwrap_or(-1);
        match op {
            10 => {
                // Hello: start heartbeat, then identify.
                let interval = payload
                    .pointer("/d/heartbeat_interval")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(41250);
                // Drop any prior heartbeat task before starting a new one.
                if let Some(h) = hb_task.take() {
                    h.abort();
                }
                let hb_writer = writer.clone();
                let hb_seq = last_seq.clone();
                let hb_flag = hb_alive.clone();
                hb_alive.store(true, Ordering::Relaxed);
                hb_task = Some(tokio::spawn(async move {
                    // Guard flips the liveness flag false on ANY exit (break or panic)
                    // so the read loop notices the dead connection promptly.
                    struct AliveGuard(Arc<AtomicBool>);
                    impl Drop for AliveGuard {
                        fn drop(&mut self) {
                            self.0.store(false, Ordering::Relaxed);
                        }
                    }
                    let _guard = AliveGuard(hb_flag);
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                        let seq = *hb_seq.lock().await;
                        let beat = json!({ "op": 1, "d": seq });
                        let mut w = hb_writer.lock().await;
                        if w.send(Message::Text(beat.to_string())).await.is_err() {
                            break;
                        }
                    }
                }));

                if !identified {
                    let identify = json!({
                        "op": 2,
                        "d": {
                            "token": ctx.token,
                            "intents": INTENTS,
                            "properties": {
                                "os": "mac",
                                "browser": "froglips",
                                "device": "froglips"
                            }
                        }
                    });
                    let mut w = writer.lock().await;
                    if let Err(e) = w.send(Message::Text(identify.to_string())).await {
                        drop(w);
                        if let Some(h) = hb_task.take() {
                            h.abort();
                        }
                        return Err(format!("identify send failed: {e}"));
                    }
                    identified = true;
                }
            }
            1 => {
                // Server requested an immediate heartbeat.
                let seq = *last_seq.lock().await;
                let beat = json!({ "op": 1, "d": seq });
                let mut w = writer.lock().await;
                let _ = w.send(Message::Text(beat.to_string())).await;
            }
            7 | 9 => {
                // Reconnect / Invalid Session: drop the connection and reconnect.
                if let Some(h) = hb_task.take() {
                    h.abort();
                }
                return Err("gateway requested reconnect".to_string());
            }
            0 => {
                let t = payload.get("t").and_then(|s| s.as_str()).unwrap_or("");
                if t == "MESSAGE_CREATE" {
                    let d = match payload.get("d") {
                        Some(d) => d,
                        None => continue,
                    };
                    // Never act on bot messages (including our own).
                    if d.pointer("/author/bot").and_then(|b| b.as_bool()) == Some(true) {
                        continue;
                    }
                    let sender = d
                        .pointer("/author/id")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let channel_id = d
                        .get("channel_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let content = d.get("content").and_then(|s| s.as_str()).unwrap_or("");
                    if content.is_empty() || channel_id.is_empty() || sender.is_empty() {
                        continue;
                    }
                    if !accept(ctx, &sender) {
                        continue;
                    }
                    let name = d
                        .pointer("/author/username")
                        .and_then(|s| s.as_str())
                        .unwrap_or("user");
                    emit(ctx, &channel_id, &sender, name, content);
                }
            }
            _ => {}
        }
    }

    if let Some(h) = hb_task.take() {
        h.abort();
    }
    Err("ws stream ended".to_string())
}

pub async fn send(token: &str, _fields: &Value, target: &str, text: &str) -> Result<(), String> {
    let token = token.trim();
    if target.is_empty() {
        return Err("bad channel id".into());
    }
    let client = &*SEND_CLIENT;
    let url = format!("{API}/channels/{target}/messages");
    for part in chunk(text, MAX_CHARS) {
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bot {token}"))
            .json(&json!({ "content": part }))
            .send()
            .await
            .map_err(|e| format!("send failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            return Err(format!(
                "send {code}: {}",
                resp.text().await.unwrap_or_default()
            ));
        }
    }
    Ok(())
}
