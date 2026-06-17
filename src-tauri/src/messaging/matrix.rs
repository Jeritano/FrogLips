//! Matrix connector — Client-Server API /sync long-poll, no public endpoint.
//!
//! run(): long-polls `/_matrix/client/v3/sync` with a Bearer access token,
//! tracks `next_batch`, and emits new `m.room.message`/`m.text` events through
//! the shared accept()+emit() gate. The `next_batch` cursor is persisted via
//! super::save_cursor/load_cursor so syncing resumes across restarts. On a
//! fresh start (no saved cursor) the very first sync only records the cursor
//! (filtered to zero timeline events) so old history is never replayed.
//! send(): PUTs an `m.room.message` with a unique transaction id.
//! validate(): `/account/whoami` -> the bot's user_id.

use super::{accept, chunk, emit, now_unix, set_error, GwCtx};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_CHARS: usize = 60000;
static TXN: AtomicU64 = AtomicU64::new(0);

/// Percent-encode a single URL path segment (room ids contain `!`, `:`, `@`,
/// `$`, etc. — none of which are safe unencoded in a path component).
fn enc_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn base(fields: &Value) -> Result<String, String> {
    let hs = fields
        .get("homeserver")
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "no homeserver configured".to_string())?;
    Ok(hs.trim_end_matches('/').to_string())
}

pub async fn validate(token: &str, fields: &Value) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("no access token stored".into());
    }
    let hs = base(fields)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{hs}/_matrix/client/v3/account/whoami"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("whoami failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        let msg = v
            .get("error")
            .and_then(|s| s.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("whoami {code}"));
        return Err(msg);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("user_id")
        .and_then(|s| s.as_str())
        .map(String::from)
        .ok_or_else(|| "whoami returned no user_id".to_string())
}

pub async fn run(ctx: GwCtx) {
    let hs = match base(&ctx.fields) {
        Ok(h) => h,
        Err(e) => {
            set_error("matrix", Some(e));
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
        }
    };
    if let Ok(uid) = validate(&ctx.token, &ctx.fields).await {
        super::set_username("matrix", Some(uid));
    }
    let bot_id = ctx
        .fields
        .get("bot_user_id")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_error("matrix", Some(format!("client build failed: {e}")));
            return;
        }
    };

    // Filter that drops all timeline/state/account events so the first sync is
    // cheap and only yields a next_batch cursor — we never replay old history.
    let initial_filter = "%7B%22room%22%3A%7B%22timeline%22%3A%7B%22limit%22%3A0%7D%7D%7D";
    // Resume from a persisted cursor if one exists; only a fresh start (no saved
    // cursor) goes through the first-sync history-skip path below.
    let mut since: Option<String> = super::load_cursor("matrix");

    loop {
        let url = match &since {
            Some(tok) => format!(
                "{hs}/_matrix/client/v3/sync?timeout=25000&since={}",
                enc_path(tok)
            ),
            None => format!("{hs}/_matrix/client/v3/sync?timeout=0&filter={initial_filter}"),
        };
        let resp = match client.get(&url).bearer_auth(&ctx.token).send().await {
            Ok(r) => r,
            Err(e) => {
                set_error("matrix", Some(format!("sync error: {e}")));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            set_error("matrix", Some(format!("sync {code}: {body}")));
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }
        let v: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                set_error("matrix", Some(format!("decode error: {e}")));
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        set_error("matrix", None);

        let next_batch = v
            .get("next_batch")
            .and_then(|s| s.as_str())
            .map(String::from);

        // First sync (no saved cursor) only records the cursor; skip processing.
        // When resuming from a persisted cursor `since` is already Some, so
        // `first` is false and we process this sync normally.
        let first = since.is_none();
        if let Some(nb) = next_batch {
            super::save_cursor("matrix", &nb);
            since = Some(nb);
        }
        if first {
            continue;
        }

        let Some(rooms) = v.pointer("/rooms/join").and_then(|r| r.as_object()) else {
            continue;
        };
        for (room_id, room) in rooms {
            let Some(events) = room.pointer("/timeline/events").and_then(|e| e.as_array()) else {
                continue;
            };
            for ev in events {
                if ev.get("type").and_then(|s| s.as_str()) != Some("m.room.message") {
                    continue;
                }
                if ev.pointer("/content/msgtype").and_then(|s| s.as_str()) != Some("m.text") {
                    continue;
                }
                let Some(sender) = ev.get("sender").and_then(|s| s.as_str()) else {
                    continue;
                };
                if !bot_id.is_empty() && sender == bot_id {
                    continue;
                }
                let Some(body) = ev.pointer("/content/body").and_then(|s| s.as_str()) else {
                    continue;
                };
                if !accept(&ctx, sender) {
                    continue;
                }
                emit(&ctx, room_id, sender, sender, body);
            }
        }
    }
}

pub async fn send(token: &str, fields: &Value, target: &str, text: &str) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("no room id".into());
    }
    let hs = base(fields)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let room = enc_path(target);
    for part in chunk(text, MAX_CHARS) {
        let txn = format!("froglips{}{}", now_unix(), TXN.fetch_add(1, Ordering::Relaxed));
        let url = format!(
            "{hs}/_matrix/client/v3/rooms/{room}/send/m.room.message/{}",
            enc_path(&txn)
        );
        let resp = client
            .put(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({ "msgtype": "m.text", "body": part }))
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
