//! Native in-process LLM inference.
//!
//! Cross-platform Native backend (see `docs/research/llamacpp-backend.md`).
//! Phase 1 split the monolithic implementation into a trait + per-platform
//! backend; Phase 2 added the llama.cpp (`llama-cpp-2`) backend behind its
//! own feature flag. Backends are mutually exclusive — see the
//! `compile_error!` below.
//!
//! Feature scheme:
//! * `native-inference` — umbrella, no-op base (kept for back-compat).
//! * `native-mistralrs` — mistralrs + candle + Metal (macOS aarch64 only).
//! * `native-llamacpp`  — llama.cpp via `llama-cpp-2` (cross-platform GGUF).
//!
//! When no backend feature is active — or `native-mistralrs` is set on a
//! non-mac-aarch64 target — dispatch falls through to `stub`, which returns
//! "Native backend not available on this platform" so the Ollama + MLX
//! paths keep working.

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

// Two backends cannot coexist: they pull in incompatible native libraries
// (Candle/Metal vs llama.cpp) and would also collide on `NativeRuntime`
// re-exports below. Pick exactly one at build time.
#[cfg(all(feature = "native-mistralrs", feature = "native-llamacpp"))]
compile_error!(
    "features `native-mistralrs` and `native-llamacpp` are mutually exclusive; \
     enable exactly one (see docs/research/llamacpp-backend.md)."
);

// mistralrs is gated on macOS aarch64 — it depends on candle-metal and only
// builds usefully on Apple Silicon. On other platforms with the feature on,
// fall through to the stub so the build still succeeds.
#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod mistralrs_backend;

#[cfg(feature = "native-llamacpp")]
mod llamacpp_backend;

#[cfg(not(any(
    all(
        feature = "native-mistralrs",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    feature = "native-llamacpp",
)))]
mod stub;

#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub use mistralrs_backend::{new_shared, NativeRuntime, SharedRuntime};

#[cfg(all(
    feature = "native-llamacpp",
    not(all(
        feature = "native-mistralrs",
        target_os = "macos",
        target_arch = "aarch64"
    )),
))]
pub use llamacpp_backend::{new_shared, NativeRuntime, SharedRuntime};

#[cfg(not(any(
    all(
        feature = "native-mistralrs",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    feature = "native-llamacpp",
)))]
pub use stub::{new_shared, NativeRuntime, SharedRuntime};

/// Convenience: human label for the current build.
///
/// `true` whenever a real backend is compiled in (mistralrs on macOS aarch64,
/// or llama.cpp on any platform with `native-llamacpp`). Returns `false` when
/// the stub is active so the frontend can hide the Native backend toggle.
pub fn native_enabled() -> bool {
    cfg!(any(
        all(
            feature = "native-mistralrs",
            target_os = "macos",
            target_arch = "aarch64"
        ),
        feature = "native-llamacpp",
    ))
}
