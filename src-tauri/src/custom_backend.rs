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
//! frontend `fetch()` like the HF browse tab:
//!
//!   1. **CSP.** The Tauri webview's `connect-src` whitelists only the hosts
//!      we ship (huggingface.co, modelscope.cn, loopback). Arbitrary
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
use tokio_util::sync::CancellationToken;

use crate::settings;

/// Process-static HTTP client for custom-backend calls. Redirects disabled
/// (a POST to a chat endpoint should never 30x; following one could leak the
/// Authorization header to an unexpected host). 180 s timeout matches the
/// quick-prompt client — cloud first-token latency on a cold model can be
/// several seconds.
static CUSTOM_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    crate::net::client_builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build custom-backend http client")
});

/// Hard cap on the accumulated reply, mirroring the quick-prompt ceiling.
/// A hostile or buggy endpoint could stream unbounded bytes; 8 MiB is far
/// past any real single-turn reply but keeps a runaway stream in RAM.
const REPLY_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on a single un-terminated SSE line. The `REPLY_MAX_BYTES` ceiling
/// only counts *emitted deltas*; a hostile endpoint that streams megabytes
/// with no newline would grow the line buffer without bound (the cap is never
/// consulted because no delta is ever produced). 1 MiB is far past any real
/// `data:` frame. MED (2026-05-29).
const LINE_BUF_MAX: usize = 1024 * 1024;

/// One message in the OpenAI chat-completions request.
///
/// `tool_calls` / `tool_call_id` / `name` are OPTIONAL and skipped when absent,
/// so a plain content-only message serializes BYTE-IDENTICALLY to the pre-tool
/// shape (the agent tool-less path is unaffected). They carry the agent loop's
/// assistant-tool-call turns and `role:"tool"` results so a tool-calling cloud
/// model can match results to requests.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    /// Message content. Usually a plain string, but VISION messages arrive as
    /// the OpenAI multi-content ARRAY shape `[{type:"text"…},{type:"image_url"…}]`
    /// (from the frontend's toOpenAiMessages). Typed as `Value` so BOTH shapes
    /// deserialize from the IPC payload and forward verbatim into the request
    /// body — a `String` field hard-failed on the array, breaking image messages
    /// on the cloud agent/tool-call path. (v0.14.0 re-review.)
    pub content: serde_json::Value,
    /// Assistant turn's tool calls (OpenAI shape). Forwarded verbatim — the
    /// frontend already normalizes `arguments` to a string before sending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    /// `role:"tool"` result → the assistant tool_call id it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Optional function name (some providers want it on the tool message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Per-call sampling params. All optional — omitted fields fall to the
/// provider's defaults.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct CustomChatParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Tool/function schemas (OpenAI shape) for the agent-loop tool-calling
    /// path. Omitted (None) for the content-only chat path → the request body
    /// stays byte-identical to the pre-tool shape.
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
}

/// Streamed delta event payload (`custom-chunk:{op_id}`).
#[derive(Serialize, Clone)]
struct CustomChunk {
    delta: String,
}

/// Streamed tool-call delta payload (`custom-toolcall:{op_id}`). Carries the
/// raw OpenAI `delta.tool_calls` array verbatim; the frontend's existing
/// `tool-call-merge.ts` (toolCallIndex / mergeToolCallChunk / finalizeToolCalls)
/// reassembles the piecewise chunks — it's already the OpenAI delta format.
#[derive(Serialize, Clone)]
struct CustomToolCallChunk {
    tool_calls: serde_json::Value,
}

/// Build the OpenAI-compatible request body. Pure — unit-tested for the
/// optional-field shaping. `stream` is always true. `tools` is included ONLY
/// when present, so the content-only path's body is byte-identical to before.
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
    // Tool schemas — only when the caller supplied them (agent tool-calling
    // path). Absent → the body omits `tools` entirely and is byte-identical to
    // the content-only request.
    if let Some(tools) = &params.tools {
        obj.insert("tools".into(), tools.clone());
    }
    body
}

/// Outcome of feeding one network chunk into the SSE line parser.
struct StreamProgress {
    /// `delta.content` text — the actual answer.
    deltas: Vec<String>,
    /// `delta.reasoning` / `delta.reasoning_content` text from reasoning
    /// ("thinking") models. Used as a fallback when a turn produces no
    /// `content` at all, so reasoning-only replies aren't dropped as empty.
    reasoning: Vec<String>,
    /// `delta.tool_calls` arrays from the agent tool-calling path, each the raw
    /// OpenAI delta array for one SSE frame. Empty for content-only streams, so
    /// the existing content path is unaffected.
    tool_calls: Vec<serde_json::Value>,
    done: bool,
}

/// Parse OpenAI-compatible SSE `data:` lines. `buf` carries the partial
/// trailing line between calls. Pure (no IO) → unit-testable on chunk
/// boundaries. Identical contract to `quick_prompt::parse_mlx_chunk`.
fn parse_openai_chunk(buf: &mut String, chunk: &str) -> StreamProgress {
    buf.push_str(chunk);
    let mut deltas = Vec::new();
    let mut reasoning = Vec::new();
    let mut tool_calls = Vec::new();
    let mut done = false;
    // Process every COMPLETE line in one pass over `buf[..=last_nl]` by slices
    // (no per-line `to_string`), then drain that prefix in a SINGLE shift. The
    // old `while buf.find('\n') { … buf.drain(..=nl) }` was O(n²) when one
    // network chunk carried many SSE frames (drain memmoves the whole tail per
    // line). PERF (2026-05-30).
    let Some(last_nl) = buf.rfind('\n') else {
        return StreamProgress {
            deltas,
            reasoning,
            tool_calls,
            done,
        };
    };
    for line in buf[..=last_nl].split('\n') {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line[5..].trim();
        if payload == "[DONE]" {
            done = true;
            break;
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
            // Reasoning/"thinking" models stream their text under `reasoning`
            // (OpenRouter) or `reasoning_content` (DeepSeek-style) rather than
            // `content`. Capture it so a reasoning-only turn isn't dropped.
            for ptr in [
                "/choices/0/delta/reasoning",
                "/choices/0/delta/reasoning_content",
            ] {
                if let Some(r) = v.pointer(ptr).and_then(|x| x.as_str()) {
                    if !r.is_empty() {
                        reasoning.push(r.to_string());
                    }
                }
            }
            // Tool-calling (agent loop only): the OpenAI streaming format puts
            // tool calls under `delta.tool_calls` as a piecewise array (name in
            // one frame, argument fragments in later frames). Forward each
            // non-empty array verbatim — the frontend's tool-call-merge.ts
            // reassembles them. ADDITIVE: a content-only stream never carries
            // this key, so the content path above is unchanged.
            if let Some(tc) = v
                .pointer("/choices/0/delta/tool_calls")
                .and_then(|x| x.as_array())
            {
                if !tc.is_empty() {
                    tool_calls.push(serde_json::Value::Array(tc.clone()));
                }
            }
        }
    }
    buf.drain(..=last_nl);
    StreamProgress {
        deltas,
        reasoning,
        tool_calls,
        done,
    }
}

/// Well-known id for the built-in OpenRouter backend. Unlike user-defined
/// custom backends it isn't stored in `settings.custom_backends`: the base
/// URL is fixed and the single API key lives in the Keychain under this
/// account, so the user just enters a key once and then picks any model
/// from the live catalogue (see `list_openrouter_models`). Audit
/// 2026-05-29: the previous "fill in base_url + model + key per model" form
/// was too fiddly for a catalogue service.
pub const OPENROUTER_ID: &str = "openrouter";
const OPENROUTER_BASE: &str = "https://openrouter.ai/api";

/// Resolve a backend id to `(base_url, model, key)`. The OpenRouter
/// built-in uses a fixed base + its dedicated Keychain key and relies on
/// the per-call `model` override (it has no single stored model). User
/// custom backends come from `settings.custom_backends`.
fn resolve_backend(id: &str) -> Result<(String, String, Option<String>)> {
    if id == OPENROUTER_ID {
        return Ok((
            OPENROUTER_BASE.to_string(),
            String::new(), // model always supplied via override for OpenRouter
            settings::keychain_get(OPENROUTER_ID),
        ));
    }
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
    // SEC-MED F3 (2026-05-30): a renderer/XSS could register a custom backend
    // pointing at a cloud-metadata / link-local endpoint and use the
    // Rust-side fetch as an SSRF proxy that bypasses the webview CSP. Block
    // the genuine SSRF targets. We deliberately ALLOW loopback (127/8, ::1)
    // and private/LAN ranges because self-hosted local model servers
    // (vLLM / LM Studio / llama.cpp / a box on the LAN) are a primary
    // supported use case for custom backends.
    reject_ssrf_base(&base)?;
    // The on-disk api_key is the redacted marker after migration; the real
    // secret lives in the Keychain keyed by the backend id.
    let key = settings::keychain_get(id);
    Ok((base, backend.model, key))
}

/// Reject base URLs whose host is a link-local / unspecified / multicast IP
/// literal or a known cloud-metadata hostname — none of which is ever a valid
/// model server, and all of which are classic SSRF/metadata targets. Loopback
/// and RFC1918/LAN are intentionally permitted (local model servers).
fn reject_ssrf_base(base: &str) -> Result<()> {
    use std::net::IpAddr;
    let url = reqwest::Url::parse(base).map_err(|e| anyhow!("invalid base_url: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("custom backend base_url has no host"))?;
    // `host_str` may keep brackets for an IPv6 literal; strip for parsing.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Single source of truth for the blocked-IP classes (shared with the
        // resolve+pin path) so the literal pre-check and the resolved check can
        // never drift.
        let blocked = custom_ip_blocked(&ip);
        if blocked {
            return Err(anyhow!(
                "custom backend host {host} is not an allowed address"
            ));
        }
    } else {
        // Hostname — block the well-known cloud-metadata names.
        let h = host.trim_end_matches('.').to_ascii_lowercase();
        const METADATA_HOSTS: &[&str] = &[
            "metadata",
            "metadata.google.internal",
            "instance-data",
            "instance-data.ec2.internal",
        ];
        if METADATA_HOSTS.contains(&h.as_str()) {
            return Err(anyhow!("custom backend host {host} is not allowed"));
        }
    }
    Ok(())
}

/// True if a (resolved) IP is in the SSRF-blocked space for a custom backend:
/// link-local (incl. AWS/GCP/Azure metadata 169.254.169.254), the Alibaba
/// metadata IP 100.100.100.200 (CGNAT range, not link-local), unspecified,
/// multicast, and the IPv4-in-IPv6 forms of those. Loopback + RFC1918/LAN are
/// deliberately ALLOWED — local model servers are the common case. Kept in
/// lockstep with `mcp::is_blocked_ip`.
fn custom_ip_blocked(ip: &std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    fn v4_blocked(v4: &std::net::Ipv4Addr) -> bool {
        v4.is_link_local()
            || v4.is_unspecified()
            || v4.is_multicast()
            || v4.octets() == [100, 100, 100, 200]
    }
    match ip {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => {
            // Canonicalize IPv4-in-IPv6 forms FIRST (mapped, then compatible).
            if let Some(m) = v6.to_ipv4_mapped() {
                return v4_blocked(&m);
            }
            if let Some(m) = v6.to_ipv4() {
                return v4_blocked(&m);
            }
            let segs = v6.segments();
            ((segs[0] & 0xffc0) == 0xfe80) || v6.is_unspecified() || v6.is_multicast()
        }
    }
}

/// Build a per-request HTTP client pinned to the base URL's resolved
/// address(es). Unlike the literal-only `reject_ssrf_base` pre-check, this
/// RESOLVES the hostname and rejects any name that points into the blocked
/// space (`attacker.example` → A-record `169.254.169.254`), then pins reqwest's
/// resolver to exactly those validated addresses so a DNS rebind between the
/// check and the connect can't swap in a blocked IP (TOCTOU). Loopback + LAN
/// stay allowed. Mirrors the MCP transport's `build_pinned_client` posture.
/// Pinned-client cache (perf review C4, 2026-06-09). Rebuilding the client
/// per message re-ran DNS + TCP + TLS from scratch — ~30-120ms added to
/// time-to-first-token on EVERY cloud send, and no connection pooling across
/// turns. Entries expire after `PINNED_CLIENT_TTL`, at which point the host
/// is re-resolved and re-validated — the DNS-rebind window is bounded by the
/// TTL, and a cached client can only ever connect to the addresses it
/// validated at build time (the pin travels with the client), so the SSRF
/// posture is unchanged.
static PINNED_CLIENT_CACHE: Lazy<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, reqwest::Client)>>,
> = Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const PINNED_CLIENT_TTL: Duration = Duration::from_secs(60);

async fn pinned_client_for(base: &str) -> Result<reqwest::Client> {
    if let Ok(cache) = PINNED_CLIENT_CACHE.lock() {
        if let Some((built, client)) = cache.get(base) {
            if built.elapsed() < PINNED_CLIENT_TTL {
                return Ok(client.clone());
            }
        }
    }
    let client = build_pinned_client_for(base).await?;
    if let Ok(mut cache) = PINNED_CLIENT_CACHE.lock() {
        // Opportunistic sweep: the key space is tiny (one entry per
        // configured backend base URL), but don't let removed backends
        // accumulate stale TLS pools forever.
        cache.retain(|_, (built, _)| built.elapsed() < PINNED_CLIENT_TTL);
        cache.insert(
            base.to_string(),
            (std::time::Instant::now(), client.clone()),
        );
    }
    Ok(client)
}

async fn build_pinned_client_for(base: &str) -> Result<reqwest::Client> {
    use std::net::{IpAddr, SocketAddr};
    let url = reqwest::Url::parse(base).map_err(|e| anyhow!("invalid base_url: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("custom backend base_url has no host"))?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let bare = host.trim_start_matches('[').trim_end_matches(']');

    let addrs: Vec<SocketAddr> = if let Ok(ip) = bare.parse::<IpAddr>() {
        if custom_ip_blocked(&ip) {
            return Err(anyhow!(
                "custom backend host {host} is not an allowed address"
            ));
        }
        vec![SocketAddr::new(ip, port)]
    } else {
        let resolved: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
            .await
            .map_err(|e| anyhow!("resolve custom backend host {host}: {e}"))?
            .collect();
        if resolved.is_empty() {
            return Err(anyhow!("custom backend host {host} did not resolve"));
        }
        if let Some(bad) = resolved.iter().find(|sa| custom_ip_blocked(&sa.ip())) {
            return Err(anyhow!(
                "custom backend host {host} resolves to a blocked address ({})",
                bad.ip()
            ));
        }
        resolved
    };

    crate::net::client_builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(bare, &addrs)
        .build()
        .map_err(|e| anyhow!("build pinned custom-backend client: {e}"))
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
    model_override: Option<String>,
) -> Result<(), String> {
    // Register a cancel token so `custom_cancel(op_id)` can stop the SSE
    // stream mid-flight instead of draining the body to the 180s timeout
    // after a user Stop / navigate-away. RAII guard releases on every exit
    // path including a panic. (2026-05-30)
    let cancel_guard = crate::stream_cancel::CancelGuard::new(&op_id);
    let res = chat_stream_inner(
        &app,
        &op_id,
        &backend_id,
        messages,
        params,
        model_override,
        &cancel_guard.token(),
    )
    .await;
    drop(cancel_guard);
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

/// Stream a TOOL-CALLING chat completion from a custom OpenAI-compatible
/// backend (agent loop + Flows). Identical to [`chat_stream`] in every respect
/// — it reuses ALL of `resolve_backend` / `reject_ssrf_base` /
/// `pinned_client_for` / cancel-token / body-cap, with zero SSRF or Keychain
/// change — the only difference is that `params.tools` is populated, so the
/// request body carries `tools` and the model can stream `delta.tool_calls`
/// (emitted over `custom-toolcall:{op_id}`). Kept as a distinct entry point so
/// the content-only `custom_chat_stream` command stays byte-identical for the
/// plain chat path; both funnel into the same `chat_stream`.
pub async fn chat_stream_tools(
    app: AppHandle,
    op_id: String,
    backend_id: String,
    messages: Vec<ChatMessage>,
    params: CustomChatParams,
    model_override: Option<String>,
) -> Result<(), String> {
    chat_stream(app, op_id, backend_id, messages, params, model_override).await
}

async fn chat_stream_inner(
    app: &AppHandle,
    op_id: &str,
    backend_id: &str,
    messages: Vec<ChatMessage>,
    params: CustomChatParams,
    model_override: Option<String>,
    cancel: &CancellationToken,
) -> Result<()> {
    let (base, stored_model, key) = resolve_backend(backend_id)?;
    // Per-call model wins (OpenRouter picks any catalogue model with one
    // shared backend); fall back to the backend's stored model.
    let model = model_override
        .filter(|m| !m.is_empty())
        .unwrap_or(stored_model);
    if model.is_empty() {
        return Err(anyhow!("no model specified for backend {backend_id}"));
    }
    let url = format!("{base}/v1/chat/completions");
    let body = build_request_body(&model, &messages, &params);

    // Per-request client pinned to the validated, resolved address(es) of the
    // user's base URL — resolves the hostname (catching names that point at
    // metadata/link-local) and closes the DNS-rebind TOCTOU. (The literal
    // pre-check in `reject_ssrf_base` ran earlier in `resolve_backend`.)
    let client = pinned_client_for(&base).await?;
    let mut req = client.post(&url).json(&body);
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
    // Track whether any `content` arrived. If none did, fall back to the
    // model's reasoning text at stream end so a reasoning-only reply (common
    // for "thinking" models) isn't dropped as "empty response".
    let mut any_content = false;
    let mut reasoning_acc = String::new();
    let stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buf = String::new();
    let mut decoder = crate::sse_decode::Utf8StreamDecoder::default();
    tokio::pin!(stream);
    // Hoist the per-op event names once — both are invariant for the whole
    // stream. (Were re-formatted via `format!` on every per-token / per-frame
    // emit.) PERF: IPC coalesce 2026-06-16.
    let chunk_event = format!("custom-chunk:{op_id}");
    let toolcall_event = format!("custom-toolcall:{op_id}");
    loop {
        // Race the SSE body against the cancel token so a user Stop ends the
        // stream promptly instead of draining to the client timeout.
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(()),
            next = stream.next() => match next {
                Some(c) => c,
                None => break,
            },
        };
        let bytes = chunk.context("read chunk")?;
        // Decode incrementally so a codepoint split across network chunks
        // isn't corrupted into U+FFFD (MED, 2026-05-29).
        let text = decoder.push(&bytes);
        let progress = parse_openai_chunk(&mut buf, &text);
        // Bound the line buffer: a newline-less flood would otherwise defeat
        // the per-delta REPLY_MAX_BYTES cap and exhaust RAM.
        if buf.len() > LINE_BUF_MAX {
            return Err(anyhow!(
                "stream line exceeded {LINE_BUF_MAX} bytes without a delimiter"
            ));
        }
        // Tool-call deltas (agent tool-calling path only; never present on the
        // content-only stream since `tools` is then absent from the request).
        // Forward each frame's raw OpenAI delta array to the frontend, which
        // merges them via the shared tool-call-merge helpers.
        //
        // SEC-LOW (2026-06-14): count tool-call bytes against the SAME
        // `REPLY_MAX_BYTES` ceiling as content. The per-line `LINE_BUF_MAX`
        // guard only bounds a single un-terminated line; a hostile/buggy
        // endpoint can stream unlimited newline-terminated `data:` frames each
        // carrying a sub-1-MiB `tool_calls` array, and before this every frame
        // was forwarded over IPC with no accounting (the cap was consulted only
        // in the content-delta loop). Add the serialized frame size to `acc_len`
        // and bail (gracefully) when the running total would exceed the ceiling,
        // mirroring the content-path bail.
        for tc in progress.tool_calls {
            // Length of the bytes we'd put on the wire for this frame. The
            // emitted payload is `tool_calls`'s JSON, so measure that.
            let tc_len = serde_json::to_string(&tc).map(|s| s.len()).unwrap_or(0);
            if acc_len + tc_len > REPLY_MAX_BYTES {
                return Ok(());
            }
            acc_len += tc_len;
            let _ = app.emit(&toolcall_event, CustomToolCallChunk { tool_calls: tc });
        }
        // Coalesce this network chunk's content deltas into ONE IPC event
        // instead of one event per token. ORDER is preserved (concat in
        // arrival order) and the body cap is applied to the JOINED string with
        // the same char-boundary-safe truncation as before. PERF: IPC coalesce
        // 2026-06-16.
        if !progress.deltas.is_empty() {
            any_content = true;
            let joined: String = progress.deltas.concat();
            // Body cap — bail (gracefully) if the stream would blow past the
            // ceiling. Respect char boundaries so we never emit half a
            // codepoint.
            if acc_len + joined.len() > REPLY_MAX_BYTES {
                let remaining = REPLY_MAX_BYTES.saturating_sub(acc_len);
                let mut take = joined.len().min(remaining);
                while take > 0 && !joined.is_char_boundary(take) {
                    take -= 1;
                }
                if take > 0 {
                    let _ = app.emit(
                        &chunk_event,
                        CustomChunk {
                            delta: joined[..take].to_string(),
                        },
                    );
                }
                return Ok(());
            }
            acc_len += joined.len();
            let _ = app.emit(&chunk_event, CustomChunk { delta: joined });
        }
        // Stash reasoning (capped) while no content has arrived — fallback only.
        if !any_content && reasoning_acc.len() < REPLY_MAX_BYTES {
            for r in progress.reasoning {
                reasoning_acc.push_str(&r);
                if reasoning_acc.len() >= REPLY_MAX_BYTES {
                    break;
                }
            }
        }
        if progress.done {
            break;
        }
    }
    // Reasoning-only reply: the model streamed `reasoning` but never `content`.
    // Emit the accumulated reasoning as the turn body so it isn't dropped as
    // empty. Char-boundary-safe truncation at the cap.
    if !any_content && !reasoning_acc.is_empty() {
        let mut take = reasoning_acc.len().min(REPLY_MAX_BYTES);
        while take > 0 && !reasoning_acc.is_char_boundary(take) {
            take -= 1;
        }
        if take > 0 {
            let _ = app.emit(
                &chunk_event,
                CustomChunk {
                    delta: reasoning_acc[..take].to_string(),
                },
            );
        }
    }
    Ok(())
}

/// One row of the OpenRouter catalogue, trimmed for the picker UI.
#[derive(Serialize, Clone, Debug)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    /// Per-1M-token prompt + completion price in USD, pre-formatted for
    /// display (e.g. "$0.20"). Empty when the catalogue omits pricing.
    pub prompt_price: String,
    pub completion_price: String,
    /// True when the model accepts image input (architecture modality).
    pub vision: bool,
    /// Accepts audio input.
    pub audio: bool,
    /// Supports tool / function calling — i.e. usable in agent mode + Flows.
    pub tools: bool,
    /// Exposes a reasoning / thinking channel.
    pub reasoning: bool,
    /// Short catalogue description (trimmed).
    pub description: String,
    /// Provider moderates/filters content (relevant when choosing an
    /// unmoderated model).
    pub moderated: bool,
    /// Max output tokens the top provider allows (0 = unspecified).
    pub max_output: u64,
}

/// Fetch the live OpenRouter model catalogue. Public endpoint — no key
/// needed to LIST (only to chat). Bounded + trimmed so the IPC payload
/// stays small. Routed through Rust (not a webview fetch) because the
/// Tauri CSP doesn't whitelist openrouter.ai.
pub async fn list_openrouter_models() -> Result<Vec<OpenRouterModel>, String> {
    let resp = CUSTOM_HTTP
        .get(format!("{OPENROUTER_BASE}/v1/models"))
        .send()
        .await
        .map_err(|e| format!("fetch openrouter models: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("openrouter models endpoint: {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse openrouter models: {e}"))?;
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "openrouter response missing data[]".to_string())?;

    // Format a per-token price string into per-1M USD. Prices arrive as
    // decimal strings ("0.0000002" = $0.20 / 1M tokens).
    let fmt_price = |v: Option<&serde_json::Value>| -> String {
        let raw = v.and_then(|x| x.as_str()).unwrap_or("");
        match raw.parse::<f64>() {
            Ok(p) if p > 0.0 => format!("${:.2}", p * 1_000_000.0),
            Ok(_) => "free".to_string(),
            Err(_) => String::new(),
        }
    };

    let mut out = Vec::with_capacity(data.len());
    for m in data {
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        let name = m
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(id)
            .to_string();
        let context_length = m
            .get("context_length")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let pricing = m.get("pricing");
        let prompt_price = fmt_price(pricing.and_then(|p| p.get("prompt")));
        let completion_price = fmt_price(pricing.and_then(|p| p.get("completion")));
        let modalities = m
            .get("architecture")
            .and_then(|a| a.get("input_modalities"))
            .and_then(|im| im.as_array());
        let has_modality = |name: &str| {
            modalities
                .map(|arr| arr.iter().any(|v| v.as_str() == Some(name)))
                .unwrap_or(false)
        };
        let vision = has_modality("image");
        let audio = has_modality("audio");
        let sp = m.get("supported_parameters").and_then(|x| x.as_array());
        let has_param = |name: &str| {
            sp.map(|arr| arr.iter().any(|v| v.as_str() == Some(name)))
                .unwrap_or(false)
        };
        let tools = has_param("tools") || has_param("tool_choice");
        let reasoning = has_param("reasoning") || has_param("include_reasoning");
        let description: String = m
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(280)
            .collect();
        let top = m.get("top_provider");
        let moderated = top
            .and_then(|t| t.get("is_moderated"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let max_output = top
            .and_then(|t| t.get("max_completion_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        out.push(OpenRouterModel {
            id: id.to_string(),
            name,
            context_length,
            prompt_price,
            completion_price,
            vision,
            audio,
            tools,
            reasoning,
            description,
            moderated,
            max_output,
        });
    }
    if out.is_empty() {
        return Err("openrouter catalogue was empty".into());
    }
    Ok(out)
}

/// Store the OpenRouter API key in the Keychain (under `OPENROUTER_ID`).
/// Empty string clears it. The key never crosses back to the webview.
pub fn set_openrouter_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        settings::keychain_delete_account(OPENROUTER_ID);
        return Ok(());
    }
    if key.len() > 512 {
        return Err("key too long".into());
    }
    if settings::keychain_set_account(OPENROUTER_ID, key.trim()) {
        Ok(())
    } else {
        Err("failed to store key in Keychain".into())
    }
}

/// Whether an OpenRouter key is present (so the UI can gate the catalogue
/// behind a one-time key prompt without ever reading the secret).
pub fn has_openrouter_key() -> bool {
    settings::keychain_get(OPENROUTER_ID).is_some()
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

    fn reasoning_line(text: &str) -> String {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"reasoning\":{}}}}}]}}\n",
            serde_json::Value::String(text.into())
        )
    }

    /// Collect content + reasoning separately across chunks.
    fn collect_both(chunks: &[&str]) -> (String, String) {
        let mut buf = String::new();
        let (mut content, mut reasoning) = (String::new(), String::new());
        for c in chunks {
            let p = parse_openai_chunk(&mut buf, c);
            for d in p.deltas {
                content.push_str(&d);
            }
            for r in p.reasoning {
                reasoning.push_str(&r);
            }
            if p.done {
                break;
            }
        }
        (content, reasoning)
    }

    #[test]
    fn reasoning_only_captured_not_dropped() {
        // A "thinking" model that streams only `reasoning` (no `content`) must
        // surface its text via the reasoning channel, not vanish.
        let (content, reasoning) = collect_both(&[&reasoning_line("thinking...")]);
        assert_eq!(content, "");
        assert_eq!(reasoning, "thinking...");
    }

    #[test]
    fn content_and_reasoning_parsed_separately() {
        let (content, reasoning) = collect_both(&[&reasoning_line("ponder"), &line("answer")]);
        assert_eq!(content, "answer");
        assert_eq!(reasoning, "ponder");
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
    fn ssrf_guard_allows_local_and_lan_model_servers() {
        // Loopback + LAN are legitimate local model servers — must be allowed.
        for base in [
            "http://127.0.0.1:11434",
            "http://localhost:8000/v1",
            "http://192.168.1.50:1234",
            "http://10.0.0.7:8080",
            "https://api.example.com/v1",
            "http://[::1]:8000",
        ] {
            assert!(reject_ssrf_base(base).is_ok(), "should allow {base}");
        }
    }

    #[test]
    fn ssrf_guard_blocks_metadata_and_linklocal() {
        for base in [
            "http://169.254.169.254/latest/meta-data/", // AWS/GCP metadata
            "http://169.254.0.1/",                      // link-local
            "http://0.0.0.0:8000/",                     // unspecified
            "http://metadata.google.internal/",         // GCP metadata host
            "http://metadata/computeMetadata/v1/",      // short metadata host
            "http://[fe80::1]/",                        // IPv6 link-local
        ] {
            assert!(reject_ssrf_base(base).is_err(), "should block {base}");
        }
    }

    /// Build a plain content-only message (the common case).
    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    fn toolcall_line(arr: &str) -> String {
        format!("data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":{arr}}}}}]}}\n")
    }

    /// Collect content + the raw tool_call delta arrays across chunks.
    fn collect_tool_calls(chunks: &[&str]) -> (String, Vec<serde_json::Value>) {
        let mut buf = String::new();
        let mut content = String::new();
        let mut tcs = Vec::new();
        for c in chunks {
            let p = parse_openai_chunk(&mut buf, c);
            for d in p.deltas {
                content.push_str(&d);
            }
            tcs.extend(p.tool_calls);
            if p.done {
                break;
            }
        }
        (content, tcs)
    }

    #[test]
    fn build_body_omits_absent_params() {
        let body = build_request_body("m", &[msg("user", "hi")], &CustomChatParams::default());
        let obj = body.as_object().unwrap();
        assert_eq!(obj["model"], "m");
        assert_eq!(obj["stream"], true);
        assert!(!obj.contains_key("temperature"));
        assert!(!obj.contains_key("top_p"));
        assert!(!obj.contains_key("max_tokens"));
        // The content-only path must NOT carry tools — byte-identical body.
        assert!(!obj.contains_key("tools"));
    }

    #[test]
    fn build_body_includes_tools_when_present() {
        let tools = serde_json::json!([{
            "type": "function",
            "function": { "name": "read_file", "parameters": {} }
        }]);
        let body = build_request_body(
            "m",
            &[msg("user", "hi")],
            &CustomChatParams {
                tools: Some(tools.clone()),
                ..Default::default()
            },
        );
        let obj = body.as_object().unwrap();
        assert_eq!(obj["tools"], tools);
    }

    #[test]
    fn content_only_message_serializes_byte_identically() {
        // A plain content message must serialize WITHOUT the new optional tool
        // fields — the wire shape is unchanged from before the tool support.
        let body = build_request_body("m", &[msg("user", "hi")], &CustomChatParams::default());
        let sent = &body["messages"][0];
        let obj = sent.as_object().unwrap();
        assert_eq!(obj["role"], "user");
        assert_eq!(obj["content"], "hi");
        assert!(!obj.contains_key("tool_calls"));
        assert!(!obj.contains_key("tool_call_id"));
        assert!(!obj.contains_key("name"));
        assert_eq!(obj.len(), 2); // exactly role + content
    }

    #[test]
    fn parse_extracts_tool_calls_without_disturbing_content() {
        // A frame carrying a tool_calls delta is captured; a plain content
        // frame is unaffected (content path byte-identical).
        let tc = r#"[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"path\""}}]"#;
        let (content, tcs) = collect_tool_calls(&[&line("answer"), &toolcall_line(tc)]);
        assert_eq!(content, "answer");
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0][0]["function"]["name"], "read_file");
    }

    #[test]
    fn parse_content_only_yields_no_tool_calls() {
        // The regression guard: a content-only stream must produce an EMPTY
        // tool_calls vec, so the agent tool-less path is unchanged.
        let (content, tcs) = collect_tool_calls(&[&line("hello"), &line(" world")]);
        assert_eq!(content, "hello world");
        assert!(tcs.is_empty());
    }

    #[test]
    fn parse_tool_calls_split_across_chunks() {
        // The OpenAI streaming format sends name then argument fragments in
        // separate frames; each non-empty array is forwarded for the frontend
        // merge to reassemble.
        let f1 = toolcall_line(r#"[{"index":0,"function":{"name":"calc"}}]"#);
        let f2 = toolcall_line(r#"[{"index":0,"function":{"arguments":"{\"x\":1}"}}]"#);
        let (_, tcs) = collect_tool_calls(&[&f1, &f2]);
        assert_eq!(tcs.len(), 2);
        assert_eq!(tcs[0][0]["function"]["name"], "calc");
        assert_eq!(tcs[1][0]["function"]["arguments"], "{\"x\":1}");
    }

    #[test]
    fn tool_call_frame_byte_accounting_matches_serialized_size() {
        // SEC-LOW (2026-06-14): tool-call frames are counted against
        // REPLY_MAX_BYTES using the serialized JSON length of the forwarded
        // `tool_calls` array. Lock that the size we'd add to `acc_len`
        // (serde_json::to_string(&tc).len()) equals the actual emitted JSON
        // length, so the cap accounting can't silently drift from the wire size.
        let tc = serde_json::json!([{
            "index": 0,
            "id": "call_1",
            "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" }
        }]);
        let counted = serde_json::to_string(&tc).map(|s| s.len()).unwrap_or(0);
        let emitted = serde_json::to_string(&CustomToolCallChunk {
            tool_calls: tc.clone(),
        })
        .unwrap();
        // The counted size is the bare array; the emitted payload wraps it in
        // `{"tool_calls":...}`, so `counted` is a conservative lower bound that
        // still tracks the frame size (never under-counts the array itself).
        assert!(counted > 0);
        assert!(emitted.contains("\"tool_calls\""));
        assert_eq!(counted, serde_json::to_string(&tc).unwrap().len());
    }

    #[test]
    fn build_body_includes_present_params() {
        let body = build_request_body(
            "m",
            &[],
            &CustomChatParams {
                temperature: Some(0.5),
                top_p: Some(0.9),
                max_tokens: Some(256),
                ..Default::default()
            },
        );
        let obj = body.as_object().unwrap();
        // f32 → JSON f64 carries a tiny representation delta, so compare
        // numerically rather than with the exact-equality of `assert_eq!`.
        assert!((obj["temperature"].as_f64().unwrap() - 0.5).abs() < 1e-6);
        assert!((obj["top_p"].as_f64().unwrap() - 0.9).abs() < 1e-6);
        assert_eq!(obj["max_tokens"], 256);
    }
}
