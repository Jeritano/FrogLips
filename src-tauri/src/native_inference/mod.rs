//! Native in-process LLM inference.
//!
//! Phase 1 of the cross-platform Native backend rollout (see
//! `docs/research/llamacpp-backend.md`): the monolithic implementation has
//! been split into a trait + per-platform backend so a second backend
//! (llama.cpp via `llama-cpp-2`) can drop in later behind a feature flag.
//!
//! Today only `mistralrs_backend` exists (macOS aarch64 + the
//! `native-inference` feature). Every other platform/feature combo falls
//! through to `stub`, which returns "Native backend not available on this
//! platform" so the Ollama + MLX paths keep working.

#![allow(dead_code)]

use std::path::PathBuf;

/// Identifier for a model the backend should load. Today only `HfRepo`
/// is constructed at call sites; `GgufPath` is reserved for the Phase 2
/// llama.cpp backend.
#[derive(Clone, Debug)]
pub enum ModelRef {
    /// Hugging Face repo id, e.g. `"mlx-community/Llama-3.2-3B-Instruct-4bit"`.
    HfRepo(String),
    /// Local path to a `.gguf` file (Phase 2; unused today).
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

/// Abstraction every backend implements. Named `NativeBackend` rather
/// than `NativeRuntime` because the concrete type at the call sites in
/// `lib.rs` is still `NativeRuntime`, and Rust doesn't allow a trait and
/// a type to share a name in the same module. Phase 2 will add a
/// second impl (`LlamaCppRuntime`) and dispatch via cfg below.
pub trait NativeBackend: Clone + Send + Sync {
    /// Load a model. The current call sites pass a HF repo id; future
    /// callers will be able to pass a local GGUF path.
    fn load(model_ref: ModelRef)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<Self>> + Send>>
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
}

/* ── Backend dispatch ─────────────────────────────────────────────────── */

#[cfg(all(feature = "native-inference", target_os = "macos", target_arch = "aarch64"))]
mod mistralrs_backend;

#[cfg(not(all(feature = "native-inference", target_os = "macos", target_arch = "aarch64")))]
mod stub;

#[cfg(all(feature = "native-inference", target_os = "macos", target_arch = "aarch64"))]
pub use mistralrs_backend::{new_shared, NativeRuntime, SharedRuntime};

#[cfg(not(all(feature = "native-inference", target_os = "macos", target_arch = "aarch64")))]
pub use stub::{new_shared, NativeRuntime, SharedRuntime};

/// Convenience: human label for the current build.
///
/// `true` only when the `native-inference` feature is on AND we're on
/// macOS aarch64 (where mistralrs currently runs). Returns `false`
/// everywhere else so the frontend can hide the Native backend toggle.
pub fn native_enabled() -> bool {
    cfg!(all(
        feature = "native-inference",
        target_os = "macos",
        target_arch = "aarch64"
    ))
}
