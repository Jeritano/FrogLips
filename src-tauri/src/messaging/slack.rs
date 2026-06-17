//! Slack connector — Socket Mode (WebSocket), no public endpoint.
//!
//! `token` holds BOTH secrets as "app_token|bot_token" (split on the first `|`):
//!   • app_token  (xapp-...) opens the Socket Mode connection.
//!   • bot_token  (xoxb-...) calls the Web API (auth.test / chat.postMessage).

use super::{accept, chunk, emit, set_error, GwCtx};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

const MAX_CHARS: usize = 3500;

/// Split the stored secret into (app_token, bot_token) on the first `|`.
fn split_tokens(token: &str) -> Result<(String, String), String> {
    match token.split_once('|') {
        Some((app, bot)) => {
            let app = app.trim().to_string();
            let bot = bot.trim().to_string();
            if app.is_empty() || bot.is_empty() {
                Err("expected 'app_token|bot_token' (one is empty)".into())
            } else {
                Ok((app, bot))
            }
        }
        None => Err("expected 'app_token|bot_token' separated by '|'".into()),
    }
}

fn http_client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .build()
        .map_err(|e| e.to_string())
}

/// Validate the bot token via auth.test; returns the bot user id on success.
pub async fn validate(token: &str, _fields: &Value) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("no token stored".into());
    }
    let (_app, bot) = split_tokens(token)?;
    let client = http_client(15)?;
    let v: Value = client
        .post("https://slack.com/api/auth.test")
        .bearer_auth(&bot)
        .send()
        .await
        .map_err(|e| format!("auth.test failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(v.get("user")
            .and_then(|s| s.as_str())
            .unwrap_or("bot")
            .to_string())
    } else {
        Err(v
            .get("error")
            .and_then(|s| s.as_str())
            .unwrap_or("invalid token")
            .to_string())
    }
}

/// Open a Socket Mode WebSocket URL using the app-level token.
async fn open_connection(client: &reqwest::Client, app_token: &str) -> Result<String, String> {
    let v: Value = client
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(app_token)
        .send()
        .await
        .map_err(|e| format!("apps.connections.open failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        v.get("url")
            .and_then(|s| s.as_str())
            .map(String::from)
            .ok_or_else(|| "apps.connections.open returned no url".into())
    } else {
        Err(v
            .get("error")
            .and_then(|s| s.as_str())
            .unwrap_or("apps.connections.open rejected")
            .to_string())
    }
}

pub async fn run(ctx: GwCtx) {
    if let Ok(name) = validate(&ctx.token, &ctx.fields).await {
        super::set_username("slack", Some(name));
    }
    let (app_token, _bot_token) = match split_tokens(&ctx.token) {
        Ok(t) => t,
        Err(e) => {
            set_error("slack", Some(e));
            // Token shape is wrong; keep the task alive but idle so it can be
            // reconfigured + restarted without bricking the registry.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
        }
    };

    let client = match http_client(20) {
        Ok(c) => c,
        Err(e) => {
            set_error("slack", Some(format!("client build failed: {e}")));
            return;
        }
    };

    loop {
        // 1) Negotiate a Socket Mode WSS URL.
        let url = match open_connection(&client, &app_token).await {
            Ok(u) => u,
            Err(e) => {
                set_error("slack", Some(e));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };

        // 2) Connect the WebSocket.
        let ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _resp)) => ws,
            Err(e) => {
                set_error("slack", Some(format!("ws connect failed: {e}")));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        set_error("slack", None);
        let (mut write, mut read) = ws.split();

        // 3) Pump frames until the socket drops, then reconnect.
        while let Some(frame) = read.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(e) => {
                    set_error("slack", Some(format!("ws read error: {e}")));
                    break;
                }
            };
            match msg {
                Message::Text(txt) => {
                    let v: Value = match serde_json::from_str(&txt) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let typ = v.get("type").and_then(|s| s.as_str()).unwrap_or("");

                    if typ == "hello" {
                        continue;
                    }
                    if typ == "disconnect" {
                        // Slack asks us to reconnect (refresh/too many connections).
                        break;
                    }

                    // ACK any enveloped message immediately so Slack doesn't retry.
                    if let Some(env_id) = v.get("envelope_id").and_then(|s| s.as_str()) {
                        let ack = serde_json::json!({ "envelope_id": env_id }).to_string();
                        if let Err(e) = write.send(Message::Text(ack)).await {
                            set_error("slack", Some(format!("ack failed: {e}")));
                            break;
                        }
                    }

                    if typ == "events_api" {
                        if let Some(event) = v.pointer("/payload/event") {
                            handle_event(&ctx, event);
                        }
                    }
                }
                Message::Ping(p) => {
                    let _ = write.send(Message::Pong(p)).await;
                }
                Message::Close(_) => {
                    break;
                }
                _ => {}
            }
        }

        // Socket dropped or asked us to reconnect; loop and re-open.
        set_error("slack", Some("reconnecting".into()));
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Process a single Events API event object, emitting allowed user messages.
fn handle_event(ctx: &GwCtx, event: &Value) {
    if event.get("type").and_then(|s| s.as_str()) != Some("message") {
        return;
    }
    // Never echo the bot's own messages (or any bot/integration message).
    if event.get("bot_id").is_some() {
        return;
    }
    // Skip message subtypes (edits, joins, deletes, etc.) — only plain user posts.
    if event.get("subtype").and_then(|s| s.as_str()).is_some() {
        return;
    }
    let Some(user) = event.get("user").and_then(|s| s.as_str()) else {
        return;
    };
    let Some(channel) = event.get("channel").and_then(|s| s.as_str()) else {
        return;
    };
    let text = event.get("text").and_then(|s| s.as_str()).unwrap_or("");
    if !accept(ctx, user) {
        return;
    }
    emit(ctx, channel, user, user, text);
}

pub async fn send(token: &str, _fields: &Value, target: &str, text: &str) -> Result<(), String> {
    let (_app, bot) = split_tokens(token)?;
    let client = http_client(30)?;
    for part in chunk(text, MAX_CHARS) {
        let v: Value = client
            .post("https://slack.com/api/chat.postMessage")
            .bearer_auth(&bot)
            .json(&serde_json::json!({ "channel": target, "text": part }))
            .send()
            .await
            .map_err(|e| format!("chat.postMessage failed: {e}"))?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            return Err(v
                .get("error")
                .and_then(|s| s.as_str())
                .unwrap_or("chat.postMessage rejected")
                .to_string());
        }
    }
    Ok(())
}
