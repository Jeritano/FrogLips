//! Custom OpenAI-compatible cloud backend.
//!
//! Lets the user point Froglips at any OpenAI-compatible `/v1/chat/completions`
//! endpoint — OpenRouter, Groq, Cerebras, Together, DeepInfra, Fireworks, a
//! self-hosted vLLM, etc. The backend config (id, name, base_url, model) lives
//! in `settings.custom_backends`; the API key lives in the macOS Keychain
//! (never on disk, never in the webview).
//!
//! ## Why this routes through Rust, not the webview
//!
//! Two reasons the chat request is made from Rust (`reqwest`) instead of a
//! frontend `fetch()` like the Civitai / HF browse tabs:
//!
//!   1. **CSP.** The Tauri webview's `connect-src` whitelists only the hosts
//!      we ship (huggingface.co, civitai.com, loopback). Arbitrary
//!      user-entered cloud hosts would be blocked, and we can't statically
//!      whitelist an open-ended set.
//!   2. **Secret hygiene.** The API key stays in the Keychain → Rust →
//!      provider. It never crosses the IPC boundary into the webview, so a
//!      compromised renderer (or a devtools session) can't read it. The
//!      webview only ever sees the redacted `__keychain__` marker.
//!
//! Streaming mirrors the native backend's event model: the command emits
//! `custom-chunk:{op_id}` per delta + a terminal `custom-done:{op_id}` /
//! `custom-error:{op_id}`, and the frontend `custom-client.ts` reassembles
//! them into an async stream.
//!
//! The SSE parse + body-cap logic is intentionally identical to
//! `quick_prompt::parse_mlx_chunk` (both consume the OpenAI streaming
//! format); kept as a local copy so the two call sites can evolve
//! independently without a shared-helper coupling.

use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::settings;

/// Process-static HTTP client for custom-backend calls. Redirects disabled
/// (a POST to a chat endpoint should never 30x; following one could leak the
/// Authorization header to an unexpected host). 180 s timeout matches the
/// quick-prompt client — cloud first-token latency on a cold model can be
/// several seconds.
static CUSTOM_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build custom-backend http client")
});

/// Hard cap on the accumulated reply, mirroring the quick-prompt ceiling.
/// A hostile or buggy endpoint could stream unbounded bytes; 8 MiB is far
/// past any real single-turn reply but keeps a runaway stream in RAM.
const REPLY_MAX_BYTES: usize = 8 * 1024 * 1024;

/// One message in the OpenAI chat-completions request.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Per-call sampling params. All optional — omitted fields fall to the
/// provider's defaults.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct CustomChatParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// Streamed delta event payload (`custom-chunk:{op_id}`).
#[derive(Serialize, Clone)]
struct CustomChunk {
    delta: String,
}

/// Build the OpenAI-compatible request body. Pure — unit-tested for the
/// optional-field shaping. `stream` is always true.
fn build_request_body(
    model: &str,
    messages: &[ChatMessage],
    params: &CustomChatParams,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages,
    });
    let obj = body.as_object_mut().expect("json object");
    if let Some(t) = params.temperature {
        obj.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(p) = params.top_p {
        obj.insert("top_p".into(), serde_json::json!(p));
    }
    if let Some(m) = params.max_tokens {
        obj.insert("max_tokens".into(), serde_json::json!(m));
    }
    body
}

/// Outcome of feeding one network chunk into the SSE line parser.
struct StreamProgress {
    deltas: Vec<String>,
    done: bool,
}

/// Parse OpenAI-compatible SSE `data:` lines. `buf` carries the partial
/// trailing line between calls. Pure (no IO) → unit-testable on chunk
/// boundaries. Identical contract to `quick_prompt::parse_mlx_chunk`.
fn parse_openai_chunk(buf: &mut String, chunk: &str) -> StreamProgress {
    buf.push_str(chunk);
    let mut deltas = Vec::new();
    while let Some(nl) = buf.find('\n') {
        let line = buf[..nl].trim().to_string();
        buf.drain(..=nl);
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line[5..].trim();
        if payload == "[DONE]" {
            return StreamProgress { deltas, done: true };
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
            if let Some(delta) = v
                .pointer("/choices/0/delta/content")
                .and_then(|x| x.as_str())
            {
                if !delta.is_empty() {
                    deltas.push(delta.to_string());
                }
            }
        }
    }
    StreamProgress { deltas, done: false }
}

/// Resolve a custom backend by id from settings, returning its base_url +
/// model + the real API key (from Keychain). Errors when the id is unknown
/// or the base_url is malformed.
fn resolve_backend(id: &str) -> Result<(String, String, Option<String>)> {
    let s = settings::load();
    let backend = s
        .custom_backends
        .unwrap_or_default()
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| anyhow!("unknown custom backend id: {id}"))?;
    let base = backend.base_url.trim_end_matches('/').to_string();
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(anyhow!("custom backend base_url must be http(s): {base}"));
    }
    // The on-disk api_key is the redacted marker after migration; the real
    // secret lives in the Keychain keyed by the backend id.
    let key = settings::keychain_get(id);
    Ok((base, backend.model, key))
}

/// Stream a chat completion from a custom OpenAI-compatible backend. Emits
/// `custom-chunk:{op_id}` per delta + a terminal `custom-done:{op_id}`;
/// errors surface via the returned `Result` AND a `custom-error:{op_id}`
/// event so the frontend settles even if it isn't awaiting the call result.
pub async fn chat_stream(
    app: AppHandle,
    op_id: String,
    backend_id: String,
    messages: Vec<ChatMessage>,
    params: CustomChatParams,
) -> Result<(), String> {
    let res = chat_stream_inner(&app, &op_id, &backend_id, messages, params).await;
    match &res {
        Ok(()) => {
            let _ = app.emit(&format!("custom-done:{op_id}"), ());
        }
        Err(e) => {
            let _ = app.emit(&format!("custom-error:{op_id}"), e.to_string());
        }
    }
    res.map_err(|e| e.to_string())
}

async fn chat_stream_inner(
    app: &AppHandle,
    op_id: &str,
    backend_id: &str,
    messages: Vec<ChatMessage>,
    params: CustomChatParams,
) -> Result<()> {
    let (base, model, key) = resolve_backend(backend_id)?;
    let url = format!("{base}/v1/chat/completions");
    let body = build_request_body(&model, &messages, &params);

    let mut req = CUSTOM_HTTP.post(&url).json(&body);
    if let Some(k) = key.as_deref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.context("POST chat completions")?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        // Trim the body so a giant HTML error page doesn't bloat the event.
        let snippet: String = txt.chars().take(500).collect();
        return Err(anyhow!("custom backend {st}: {snippet}"));
    }

    let mut acc_len = 0usize;
    let stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buf = String::new();
    tokio::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("read chunk")?;
        let progress = parse_openai_chunk(&mut buf, &String::from_utf8_lossy(&bytes));
        for delta in progress.deltas {
            // Body cap — bail (gracefully) if the stream would blow past the
            // ceiling. Respect char boundaries so we never emit half a
            // codepoint.
            if acc_len + delta.len() > REPLY_MAX_BYTES {
                let remaining = REPLY_MAX_BYTES.saturating_sub(acc_len);
                let mut take = delta.len().min(remaining);
                while take > 0 && !delta.is_char_boundary(take) {
                    take -= 1;
                }
                if take > 0 {
                    let _ = app.emit(
                        &format!("custom-chunk:{op_id}"),
                        CustomChunk { delta: delta[..take].to_string() },
                    );
                }
                return Ok(());
            }
            acc_len += delta.len();
            let _ = app.emit(
                &format!("custom-chunk:{op_id}"),
                CustomChunk { delta },
            );
        }
        if progress.done {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(content: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n",
            serde_json::Value::String(content.into())
        )
    }

    fn collect(chunks: &[&str]) -> (String, bool) {
        let mut buf = String::new();
        let mut acc = String::new();
        let mut done = false;
        for c in chunks {
            let p = parse_openai_chunk(&mut buf, c);
            for d in p.deltas {
                acc.push_str(&d);
            }
            if p.done {
                done = true;
                break;
            }
        }
        (acc, done)
    }

    #[test]
    fn parses_single_line() {
        let (acc, done) = collect(&[&line("hello")]);
        assert_eq!(acc, "hello");
        assert!(!done);
    }

    #[test]
    fn handles_line_split_across_chunks() {
        let full = line("split me");
        let (a, b) = full.split_at(full.len() / 2);
        let (acc, _) = collect(&[a, b]);
        assert_eq!(acc, "split me");
    }

    #[test]
    fn multiple_lines_per_chunk() {
        let blob = format!("{}{}", line("foo"), line("bar"));
        let (acc, _) = collect(&[&blob]);
        assert_eq!(acc, "foobar");
    }

    #[test]
    fn done_marker_terminates() {
        let chunk = format!("{}data: [DONE]\n", line("x"));
        let (acc, done) = collect(&[&chunk]);
        assert_eq!(acc, "x");
        assert!(done);
    }

    #[test]
    fn ignores_keepalive_comments() {
        let (acc, _) = collect(&[": keep-alive\n", &line("ok")]);
        assert_eq!(acc, "ok");
    }

    #[test]
    fn build_body_omits_absent_params() {
        let body = build_request_body(
            "m",
            &[ChatMessage { role: "user".into(), content: "hi".into() }],
            &CustomChatParams::default(),
        );
        let obj = body.as_object().unwrap();
        assert_eq!(obj["model"], "m");
        assert_eq!(obj["stream"], true);
        assert!(!obj.contains_key("temperature"));
        assert!(!obj.contains_key("top_p"));
        assert!(!obj.contains_key("max_tokens"));
    }

    #[test]
    fn build_body_includes_present_params() {
        let body = build_request_body(
            "m",
            &[],
            &CustomChatParams { temperature: Some(0.5), top_p: Some(0.9), max_tokens: Some(256) },
        );
        let obj = body.as_object().unwrap();
        // f32 → JSON f64 carries a tiny representation delta, so compare
        // numerically rather than with the exact-equality of `assert_eq!`.
        assert!((obj["temperature"].as_f64().unwrap() - 0.5).abs() < 1e-6);
        assert!((obj["top_p"].as_f64().unwrap() - 0.9).abs() < 1e-6);
        assert_eq!(obj["max_tokens"], 256);
    }
}
