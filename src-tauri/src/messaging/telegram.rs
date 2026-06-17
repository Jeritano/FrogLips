//! Telegram connector — Bot API long-poll (getUpdates), no public endpoint.

use super::{accept, chunk, emit, set_error, GwCtx};
use once_cell::sync::Lazy;
use serde_json::Value;

const MAX_CHARS: usize = 3800;

/// Shared HTTP client, built once and reused across all calls.
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .expect("telegram reqwest client build")
});

pub async fn validate(token: &str) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("no token stored".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let v: Value = client
        .get(format!("https://api.telegram.org/bot{token}/getMe"))
        .send()
        .await
        .map_err(|e| format!("getMe failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(v.pointer("/result/username")
            .and_then(|s| s.as_str())
            .unwrap_or("bot")
            .to_string())
    } else {
        Err(v
            .get("description")
            .and_then(|s| s.as_str())
            .unwrap_or("invalid token")
            .to_string())
    }
}

pub async fn run(ctx: GwCtx) {
    if let Ok(name) = validate(&ctx.token).await {
        super::set_username("telegram", Some(name));
    }
    let client = &*CLIENT;
    let token = ctx.token.clone();
    let mut backoff = super::Backoff::new();
    let mut offset: i64 = super::load_cursor("telegram")
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    loop {
        let url = format!(
            "https://api.telegram.org/bot{token}/getUpdates?timeout=25&offset={offset}&allowed_updates=%5B%22message%22%5D"
        );
        let v: Value = match client.get(&url).send().await {
            Ok(r) => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    set_error("telegram", Some(format!("decode error: {e}")));
                    backoff.sleep().await;
                    continue;
                }
            },
            Err(e) => {
                set_error("telegram", Some(format!("poll error: {e}")));
                backoff.sleep().await;
                continue;
            }
        };
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            set_error(
                "telegram",
                v.get("description").and_then(|s| s.as_str()).map(String::from),
            );
            backoff.sleep().await;
            continue;
        }
        set_error("telegram", None);
        // A well-formed `ok:true` always carries `result`; if it's missing
        // (proxy/API quirk), back off instead of spinning the loop (review M3).
        let Some(updates) = v.get("result").and_then(|r| r.as_array()) else {
            backoff.sleep().await;
            continue;
        };
        backoff.reset();
        let offset_before = offset;
        for upd in updates {
            if let Some(uid) = upd.get("update_id").and_then(|n| n.as_i64()) {
                offset = uid + 1;
            }
            let Some(msg) = upd.get("message") else { continue };
            let Some(text) = msg.get("text").and_then(|s| s.as_str()) else {
                continue;
            };
            let sender = msg
                .pointer("/from/id")
                .and_then(|n| n.as_i64())
                .map(|n| n.to_string())
                .unwrap_or_default();
            let chat = msg
                .pointer("/chat/id")
                .and_then(|n| n.as_i64())
                .map(|n| n.to_string())
                .unwrap_or_default();
            if !accept(&ctx, &sender) {
                continue;
            }
            let name = msg
                .pointer("/from/first_name")
                .and_then(|s| s.as_str())
                .or_else(|| msg.pointer("/from/username").and_then(|s| s.as_str()))
                .unwrap_or("user");
            emit(&ctx, &chat, &sender, name, text);
        }
        if offset != offset_before {
            super::save_cursor("telegram", &offset.to_string());
        }
    }
}

pub async fn send(token: &str, _fields: &Value, target: &str, text: &str) -> Result<(), String> {
    let chat_id: i64 = target.parse().map_err(|_| "bad chat id".to_string())?;
    let client = &*CLIENT;
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    for part in chunk(text, MAX_CHARS) {
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "chat_id": chat_id, "text": part }))
            .send()
            .await
            .map_err(|e| format!("sendMessage failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            return Err(format!("sendMessage {code}: {}", resp.text().await.unwrap_or_default()));
        }
    }
    Ok(())
}
