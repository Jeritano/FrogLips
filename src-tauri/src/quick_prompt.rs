// Menu-bar quick-prompt: ephemeral, no persistence. Streams a single LLM reply
// over `quick-prompt-response:{op_id}` events and fires a final
// `quick-prompt-completed` event so the main ChatWindow can toast.
//
// Routes to whichever backend (MLX or Ollama) is currently running. Falls back
// to the persisted `last_model` / `last_backend` if no server is live — this
// is purely best-effort; if neither path resolves we emit an error chunk and
// complete. Strict v1.3: no images, no history, no memory, no model picker.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::settings;

/// Quick-prompt window logical size. Frameless, always-on-top, centered.
/// Width holds a comfortable prompt; height fits the textarea + a single
/// streamed-reply preview pane (caller may grow content but we don't auto-resize).
pub const QUICK_WIDTH: f64 = 600.0;
pub const QUICK_HEIGHT: f64 = 120.0;

/// Stable label for the quick prompt window. Single instance; reopen reuses it.
pub const QUICK_LABEL: &str = "quick";

#[derive(Serialize, Clone)]
pub struct QuickPromptChunk {
    pub op_id: String,
    pub delta: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct QuickPromptCompleted {
    pub op_id: String,
    pub reply: String,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaStreamLine {
    #[serde(default)]
    message: Option<OllamaMessage>,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
struct OllamaMessage {
    #[serde(default)]
    content: String,
}

/// Outcome of feeding one network chunk into a streaming line parser.
struct StreamProgress {
    /// Content deltas extracted from complete lines in this chunk.
    deltas: Vec<String>,
    /// True once a stream-terminating line was seen (`[DONE]` / `done:true`).
    done: bool,
}

/// Parse SSE `data:` lines from the OpenAI-compatible streaming format.
/// `buf` carries the partial trailing line between calls; complete lines are
/// drained from it. Pure (no IO) so it's unit-testable on chunk boundaries.
fn parse_mlx_chunk(buf: &mut String, chunk: &str) -> StreamProgress {
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
    StreamProgress {
        deltas,
        done: false,
    }
}

/// Parse Ollama NDJSON streaming frames. Same line-buffering contract as
/// [`parse_mlx_chunk`]: `buf` retains the partial trailing line between calls.
fn parse_ollama_chunk(buf: &mut String, chunk: &str) -> StreamProgress {
    buf.push_str(chunk);
    let mut deltas = Vec::new();
    while let Some(nl) = buf.find('\n') {
        let line = buf[..nl].trim().to_string();
        buf.drain(..=nl);
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<OllamaStreamLine>(&line) {
            if let Some(msg) = parsed.message {
                if !msg.content.is_empty() {
                    deltas.push(msg.content);
                }
            }
            if parsed.done {
                return StreamProgress { deltas, done: true };
            }
        }
    }
    StreamProgress {
        deltas,
        done: false,
    }
}

/// Create the quick prompt window on demand. If it already exists, just
/// show + focus it. Returns the window so the caller can position/center it.
pub fn ensure_window(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window(QUICK_LABEL) {
        existing.show().ok();
        existing.set_focus().ok();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        QUICK_LABEL,
        WebviewUrl::App("index.html?quick=1".into()),
    )
    .title("Froglips Quick Prompt")
    .inner_size(QUICK_WIDTH, QUICK_HEIGHT)
    .always_on_top(true)
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .focused(true)
    .center()
    .build()
    .map_err(|e| anyhow!("create quick window failed: {e}"))?;

    // Hide on blur — keep alive for fast reopen. Best-effort; if blur events
    // aren't delivered (some platforms) the user can still Esc to hide.
    let app_for_blur = app.clone();
    win.on_window_event(move |evt| {
        if let tauri::WindowEvent::Focused(false) = evt {
            if let Some(w) = app_for_blur.get_webview_window(QUICK_LABEL) {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

/// Toggle window visibility. Called from the global shortcut handler.
pub fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK_LABEL) {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else {
        let _ = ensure_window(app);
    }
}

/// Resolve the model + backend to use. Prefers the currently running server
/// (read from settings.last_*), but does not start anything.
fn resolve_default() -> Result<(String, String)> {
    let s = settings::load();
    let backend = s
        .last_backend
        .ok_or_else(|| anyhow!("no default backend in settings — start a model first"))?;
    let model = s
        .last_model
        .ok_or_else(|| anyhow!("no default model in settings — start a model first"))?;
    if backend != "mlx" && backend != "ollama" {
        return Err(anyhow!("unsupported backend for quick prompt: {backend}"));
    }
    Ok((model, backend))
}

/// Stream a reply from the OpenAI-compatible MLX endpoint. Emits per-chunk
/// deltas on `quick-prompt-response:{op_id}`. Returns the accumulated reply.
async fn stream_mlx(
    app: AppHandle,
    op_id: String,
    model: String,
    prompt: String,
) -> Result<String> {
    let url = format!(
        "http://{}:{}/v1/chat/completions",
        crate::backend_process::MLX_HOST,
        crate::backend_process::MLX_PORT
    );
    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "temperature": 0.7,
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .context("build http client")?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .context("POST chat completions")?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(anyhow!("mlx server {st}: {txt}"));
    }
    let mut acc = String::new();
    let stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buf = String::new();
    tokio::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("read chunk")?;
        let progress = parse_mlx_chunk(&mut buf, &String::from_utf8_lossy(&bytes));
        for delta in progress.deltas {
            acc.push_str(&delta);
            let _ = app.emit(
                &format!("quick-prompt-response:{op_id}"),
                QuickPromptChunk {
                    op_id: op_id.clone(),
                    delta,
                    done: false,
                    error: None,
                },
            );
        }
        if progress.done {
            return Ok(acc);
        }
    }
    Ok(acc)
}

/// Stream from Ollama's `/api/chat`. Uses its native NDJSON stream rather
/// than the OpenAI-compat path so we don't depend on Ollama's compat-mode flags.
async fn stream_ollama(
    app: AppHandle,
    op_id: String,
    model: String,
    prompt: String,
) -> Result<String> {
    let url = format!(
        "http://{}:{}/api/chat",
        crate::backend_process::OLLAMA_HOST,
        crate::backend_process::OLLAMA_PORT
    );
    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .context("build http client")?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .context("POST ollama chat")?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ollama {st}: {txt}"));
    }
    // NDJSON: pull bytes, split on '\n', JSON-decode each non-empty frame.
    let mut acc = String::new();
    let stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buf = String::new();
    tokio::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("read ollama chunk")?;
        let progress = parse_ollama_chunk(&mut buf, &String::from_utf8_lossy(&bytes));
        for delta in progress.deltas {
            acc.push_str(&delta);
            let _ = app.emit(
                &format!("quick-prompt-response:{op_id}"),
                QuickPromptChunk {
                    op_id: op_id.clone(),
                    delta,
                    done: false,
                    error: None,
                },
            );
        }
        if progress.done {
            return Ok(acc);
        }
    }
    Ok(acc)
}

/// Run a quick prompt end-to-end. Spawns onto the tokio runtime; on completion
/// emits `quick-prompt-completed` to the main window. Errors are surfaced
/// inside the completion event rather than propagated as a Tauri command error,
/// so the quick window UI always settles into a final state.
pub async fn run(app: AppHandle, op_id: String, text: String) -> Result<(), String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("prompt empty".into());
    }
    if trimmed.len() > 8 * 1024 {
        return Err("prompt too long (max 8 KiB)".into());
    }

    let (model, backend) = match resolve_default() {
        Ok(t) => t,
        Err(e) => {
            let _ = app.emit(
                &format!("quick-prompt-response:{op_id}"),
                QuickPromptChunk {
                    op_id: op_id.clone(),
                    delta: String::new(),
                    done: true,
                    error: Some(e.to_string()),
                },
            );
            let _ = app.emit(
                "quick-prompt-completed",
                QuickPromptCompleted {
                    op_id,
                    reply: String::new(),
                    model: None,
                    backend: None,
                    error: Some(e.to_string()),
                },
            );
            return Ok(());
        }
    };

    let result = if backend == "ollama" {
        stream_ollama(app.clone(), op_id.clone(), model.clone(), trimmed).await
    } else {
        stream_mlx(app.clone(), op_id.clone(), model.clone(), trimmed).await
    };

    match result {
        Ok(reply) => {
            let _ = app.emit(
                &format!("quick-prompt-response:{op_id}"),
                QuickPromptChunk {
                    op_id: op_id.clone(),
                    delta: String::new(),
                    done: true,
                    error: None,
                },
            );
            let _ = app.emit(
                "quick-prompt-completed",
                QuickPromptCompleted {
                    op_id,
                    reply,
                    model: Some(model),
                    backend: Some(backend),
                    error: None,
                },
            );
        }
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit(
                &format!("quick-prompt-response:{op_id}"),
                QuickPromptChunk {
                    op_id: op_id.clone(),
                    delta: String::new(),
                    done: true,
                    error: Some(msg.clone()),
                },
            );
            let _ = app.emit(
                "quick-prompt-completed",
                QuickPromptCompleted {
                    op_id,
                    reply: String::new(),
                    model: Some(model),
                    backend: Some(backend),
                    error: Some(msg),
                },
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_mlx(chunks: &[&str]) -> (String, bool) {
        let mut buf = String::new();
        let mut acc = String::new();
        let mut done = false;
        for c in chunks {
            let p = parse_mlx_chunk(&mut buf, c);
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

    fn collect_ollama(chunks: &[&str]) -> (String, bool) {
        let mut buf = String::new();
        let mut acc = String::new();
        let mut done = false;
        for c in chunks {
            let p = parse_ollama_chunk(&mut buf, c);
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

    fn mlx_line(content: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n",
            serde_json::Value::String(content.into())
        )
    }

    #[test]
    fn mlx_parses_single_complete_line() {
        let (acc, done) = collect_mlx(&[&mlx_line("hello")]);
        assert_eq!(acc, "hello");
        assert!(!done);
    }

    #[test]
    fn mlx_handles_line_split_across_chunks() {
        let full = mlx_line("split me");
        let (a, b) = full.split_at(full.len() / 2);
        let (acc, _) = collect_mlx(&[a, b]);
        assert_eq!(acc, "split me");
    }

    #[test]
    fn mlx_handles_multiple_lines_per_chunk() {
        let blob = format!("{}{}", mlx_line("foo"), mlx_line("bar"));
        let (acc, _) = collect_mlx(&[&blob]);
        assert_eq!(acc, "foobar");
    }

    #[test]
    fn mlx_done_marker_terminates() {
        let chunk = format!("{}data: [DONE]\n", mlx_line("x"));
        let (acc, done) = collect_mlx(&[&chunk]);
        assert_eq!(acc, "x");
        assert!(done);
    }

    #[test]
    fn mlx_ignores_non_data_lines() {
        let (acc, _) = collect_mlx(&[": keep-alive comment\n", &mlx_line("ok")]);
        assert_eq!(acc, "ok");
    }

    #[test]
    fn ollama_parses_and_terminates_on_done() {
        let chunks = [
            "{\"message\":{\"content\":\"hel\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"lo\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"\"},\"done\":true}\n",
        ];
        let (acc, done) = collect_ollama(&chunks);
        assert_eq!(acc, "hello");
        assert!(done);
    }

    #[test]
    fn ollama_handles_frame_split_mid_line() {
        let line = "{\"message\":{\"content\":\"abc\"},\"done\":false}\n";
        let (a, b) = line.split_at(10);
        let (acc, _) = collect_ollama(&[a, b]);
        assert_eq!(acc, "abc");
    }

    #[test]
    fn ollama_skips_blank_lines() {
        let (acc, _) = collect_ollama(&["\n\n{\"message\":{\"content\":\"z\"},\"done\":false}\n"]);
        assert_eq!(acc, "z");
    }
}
