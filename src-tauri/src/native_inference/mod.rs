//! Native in-process LLM inference.
//!
//! Froglips is a native macOS app — the backend is mistralrs + candle +
//! Metal, behind the `native-mistralrs` feature. The implementation is split
//! into a trait (`NativeBackend`) and a backend impl.
//!
//! Feature scheme:
//! * `native-inference` — umbrella, no-op base (kept for back-compat).
//! * `native-mistralrs` — mistralrs + candle + Metal (macOS aarch64 only).
//!
//! When the feature is off — or set on a non-mac-aarch64 target — dispatch
//! falls through to `stub`, which returns "Native backend not available on
//! this platform" so the Ollama + MLX paths keep working.

#![allow(dead_code)]

use std::path::PathBuf;

/// Identifier for a model the backend should load. The mistralrs backend
/// accepts `HfRepo` (and rejects `GgufPath`); the llama.cpp backend
/// accepts `GgufPath` (and rejects `HfRepo` until Phase 3 wires up the
/// HF GGUF download path).
#[derive(Clone, Debug)]
pub enum ModelRef {
    /// Hugging Face repo id, e.g. `"mlx-community/Llama-3.2-3B-Instruct-4bit"`.
    HfRepo(String),
    /// Local path to a `.gguf` file (llama.cpp backend).
    GgufPath(PathBuf),
}

/// Sampling knobs we expose at the IPC boundary. Backends translate this
/// to their native sampling params type.
#[derive(Clone, Debug, Default)]
pub struct SamplingOpts {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<usize>,
}

/// A single chat message at the IPC boundary. Kept as a tuple-alias so
/// the existing call sites in `lib.rs` (`Vec<(String, String)>`) keep
/// working unchanged.
pub type ChatMsg = (String, String);

/// A function tool call emitted by a backend during agent mode. Mirrors the
/// OpenAI `tool_calls[]` entry shape the frontend agent loop consumes.
#[derive(Clone, Debug, serde::Serialize)]
pub struct NativeToolCall {
    pub id: String,
    pub name: String,
    /// Arguments as a raw JSON string (the agent loop parses it).
    pub arguments: String,
}

/// Outcome of one tool-calling chat turn: the assistant text plus any tool
/// calls the model requested.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ChatTurn {
    pub content: String,
    pub tool_calls: Vec<NativeToolCall>,
}

/// Abstraction every backend implements. Named `NativeBackend` rather
/// than `NativeRuntime` because the concrete type at the call sites in
/// `lib.rs` is still `NativeRuntime`, and Rust doesn't allow a trait and
/// a type to share a name in the same module. Phase 2 will add a
/// second impl (`LlamaCppRuntime`) and dispatch via cfg below.
pub trait NativeBackend: Clone + Send + Sync {
    /// Load a model. The current call sites pass a HF repo id; future
    /// callers will be able to pass a local GGUF path.
    fn load(
        model_ref: ModelRef,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<Self>> + Send>>
    where
        Self: Sized;

    fn model_id(&self) -> &str;

    /// Stream a chat completion. `on_chunk` fires once per assistant
    /// delta; returns the concatenated final text on success.
    #[allow(clippy::type_complexity)]
    fn chat_stream(
        &self,
        messages: Vec<ChatMsg>,
        sampling: SamplingOpts,
        on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send + '_>>;

    /// Stream a tool-calling chat turn. `messages` and `tools` are
    /// OpenAI-style JSON values (messages carry `role`/`content` plus
    /// optional `tool_calls`/`tool_call_id`); `on_chunk` fires per assistant
    /// text delta. Returns the final text plus any tool calls the model
    /// requested.
    ///
    /// Backends without tool-call support return an error from the default
    /// impl; only the mistralrs backend overrides it.
    #[allow(clippy::type_complexity)]
    fn chat_stream_tools(
        &self,
        _messages: Vec<serde_json::Value>,
        _tools: Vec<serde_json::Value>,
        _sampling: SamplingOpts,
        _on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<ChatTurn>> + Send + '_>>
    {
        Box::pin(async move {
            Err(anyhow::anyhow!(
                "this native backend does not support tool calling"
            ))
        })
    }
}

/* ── Backend dispatch ─────────────────────────────────────────────────── */

// mistralrs is gated on macOS aarch64 — it depends on candle-metal and only
// builds usefully on Apple Silicon. Off the feature, or on another target,
// dispatch falls through to the stub so the build still succeeds.
#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod mistralrs_backend;

#[cfg(not(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
)))]
mod stub;

#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub use mistralrs_backend::{new_shared, NativeRuntime, SharedRuntime};

#[cfg(not(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
)))]
pub use stub::{new_shared, NativeRuntime, SharedRuntime};

/// `true` when the real mistralrs backend is compiled in (macOS aarch64 with
/// `native-mistralrs`). Returns `false` when the stub is active so the
/// frontend can hide the Native backend toggle.
pub fn native_enabled() -> bool {
    cfg!(all(
        feature = "native-mistralrs",
        target_os = "macos",
        target_arch = "aarch64"
    ))
}
