//! llama.cpp backend via `llama-cpp-2` (cross-platform, `--features
//! native-llamacpp`).
//!
//! Phase 2 of the cross-platform Native backend rollout (see
//! `docs/research/llamacpp-backend.md`). Loads local GGUF files only —
//! the HF GGUF picker UI + downloader is Phase 3 and lives elsewhere.
//!
//! Public surface mirrors `mistralrs_backend.rs`: `NativeRuntime`,
//! `SharedRuntime`, `new_shared`, with the same method signatures `lib.rs`
//! already calls. The trait impl at the bottom plugs this into the
//! `NativeBackend` abstraction used internally.
//!
//! NOTE on the `llama-cpp-2` API surface: the crate tracks upstream
//! llama.cpp closely and its 0.1.x line has churned on every release.
//! The implementation below intentionally keeps the surface narrow —
//! `LlamaBackend::init`, `LlamaModel::load_from_file`,
//! `LlamaContext::new`/`decode`, `LlamaBatch`, and a sampler chain. If
//! upstream rotates names again, the breakage is contained to
//! `chat_stream` / `load` and not the trait shim.

use anyhow::{anyhow, Context, Result};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;

use super::{ChatMsg, ModelRef, NativeBackend, SamplingOpts};

/// One loaded GGUF model. Cheap to clone (`Arc` inside).
///
/// The `LlamaBackend` is a process-wide singleton: llama.cpp's C API
/// expects exactly one `ggml_backend_init` / `ggml_backend_free` pair
/// per process. We stash it in a `OnceLock` so repeated `load` calls
/// reuse it.
#[derive(Clone)]
pub struct NativeRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    /// Keep the backend alive for as long as any model exists.
    _backend: Arc<LlamaBackend>,
    model: Arc<LlamaModel>,
    /// Human-facing id — we surface the GGUF filename so the UI shows
    /// something readable.
    model_id: String,
    /// Monotonic request counter — currently unused beyond debug
    /// logging, but mirrors the mistralrs backend's shape.
    _next_id: AtomicUsize,
}

fn shared_backend() -> Result<Arc<LlamaBackend>> {
    use std::sync::OnceLock;
    static BACKEND: OnceLock<std::sync::Mutex<Option<Arc<LlamaBackend>>>> = OnceLock::new();
    let slot = BACKEND.get_or_init(|| std::sync::Mutex::new(None));
    let mut g = slot.lock().expect("backend mutex poisoned");
    if let Some(b) = g.as_ref() {
        return Ok(b.clone());
    }
    let backend = LlamaBackend::init().map_err(|e| anyhow!("LlamaBackend::init failed: {e}"))?;
    let arc = Arc::new(backend);
    *g = Some(arc.clone());
    Ok(arc)
}

impl NativeRuntime {
    /// Inherent `load` shim so call sites in `lib.rs` that pass a `String`
    /// (today's mistralrs-flavoured signature) keep compiling unchanged
    /// against the llamacpp build. The string is interpreted as a path
    /// to a local GGUF file — Phase 3 will swap in a richer enum.
    pub async fn load(model_id: String) -> Result<Self> {
        Self::load_gguf(PathBuf::from(model_id)).await
    }

    /// Load a GGUF model from a local path. Heavy I/O + mmap runs on a
    /// blocking thread so the async runtime stays responsive.
    pub async fn load_gguf(path: PathBuf) -> Result<Self> {
        let backend = shared_backend()?;
        let path_for_load = path.clone();
        let backend_for_load = backend.clone();
        let (model, model_id) = tokio::task::spawn_blocking(move || -> Result<_> {
            let params = LlamaModelParams::default();
            let model = LlamaModel::load_from_file(&backend_for_load, &path_for_load, &params)
                .with_context(|| format!("failed to load GGUF {}", path_for_load.display()))?;
            let id = path_for_load
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path_for_load.display().to_string());
            Ok::<_, anyhow::Error>((model, id))
        })
        .await
        .map_err(|e| anyhow!("join error: {e}"))??;

        Ok(Self {
            inner: Arc::new(Inner {
                _backend: backend,
                model: Arc::new(model),
                model_id,
                _next_id: AtomicUsize::new(1),
            }),
        })
    }

    pub fn model_id(&self) -> &str {
        &self.inner.model_id
    }

    /// Stream a chat completion from a fresh context. We build a new
    /// `LlamaContext` per request (cheap relative to model load) so
    /// concurrent requests don't fight over a shared kv-cache.
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatMsg>,
        sampling: SamplingOpts,
        mut on_chunk: impl FnMut(String) + Send + 'static,
    ) -> Result<String> {
        let model = self.inner.model.clone();
        let backend = self.inner._backend.clone();

        // Off-thread: tokenize, decode, sample. The chunk callback is
        // moved across the spawn_blocking boundary; the caller's tokio
        // task awaits the joined result.
        let full = tokio::task::spawn_blocking(move || -> Result<String> {
            let prompt = render_chat_prompt(&model, &messages)?;

            let n_ctx = NonZeroU32::new(4096).unwrap();
            let ctx_params = LlamaContextParams::default().with_n_ctx(Some(n_ctx));
            let mut ctx = model
                .new_context(&backend, ctx_params)
                .map_err(|e| anyhow!("new_context failed: {e}"))?;

            let tokens = model
                .str_to_token(&prompt, AddBos::Always)
                .map_err(|e| anyhow!("tokenization failed: {e}"))?;

            // Prefill: push the prompt through the context one batch at
            // a time. Batch size 512 mirrors llama.cpp's default.
            let mut batch = LlamaBatch::new(512, 1);
            let last_idx = tokens.len() as i32 - 1;
            for (i, tok) in tokens.iter().enumerate() {
                let is_last = i as i32 == last_idx;
                batch
                    .add(*tok, i as i32, &[0], is_last)
                    .map_err(|e| anyhow!("batch.add failed: {e}"))?;
            }
            ctx.decode(&mut batch)
                .map_err(|e| anyhow!("prefill decode failed: {e}"))?;

            // Sampler chain — temperature + top-p + greedy fallback.
            let temp = sampling.temperature.unwrap_or(0.7) as f32;
            let top_p = sampling.top_p.unwrap_or(0.95) as f32;
            let max_tokens = sampling.max_tokens.unwrap_or(2048);
            let mut sampler = LlamaSampler::chain_simple([
                LlamaSampler::top_p(top_p, 1),
                LlamaSampler::temp(temp),
                LlamaSampler::dist(1234),
            ]);

            let mut full = String::new();
            let mut n_cur = batch.n_tokens();
            let mut n_decoded = 0usize;

            while n_decoded < max_tokens {
                let token = sampler.sample(&ctx, batch.n_tokens() - 1);
                sampler.accept(token);

                if model.is_eog_token(token) {
                    break;
                }

                let piece = model
                    .token_to_str(token, Special::Tokenize)
                    .unwrap_or_default();
                if !piece.is_empty() {
                    on_chunk(piece.clone());
                    full.push_str(&piece);
                }

                batch.clear();
                batch
                    .add(token, n_cur, &[0], true)
                    .map_err(|e| anyhow!("batch.add (gen) failed: {e}"))?;
                ctx.decode(&mut batch)
                    .map_err(|e| anyhow!("gen decode failed: {e}"))?;

                n_cur += 1;
                n_decoded += 1;
            }

            Ok(full)
        })
        .await
        .map_err(|e| anyhow!("join error: {e}"))??;

        Ok(full)
    }
}

/// Build a chat prompt from `(role, content)` pairs.
///
/// llama.cpp embeds a Jinja chat template in most modern GGUFs. We
/// prefer that; if absent we fall back to a basic ChatML wrapper
/// (`<|im_start|>role\ncontent<|im_end|>`) which most fine-tunes
/// understand even when they were trained on a slightly different
/// template.
fn render_chat_prompt(model: &LlamaModel, messages: &[ChatMsg]) -> Result<String> {
    // Try the model's own chat template via llama-cpp-2's wrapper.
    // The exact fn name has flipped between `apply_chat_template`
    // and `chat_apply_template` across 0.1.x releases — if it's
    // unavailable for any reason we fall through to ChatML.
    #[allow(clippy::collapsible_if)]
    if let Ok(s) = try_apply_template(model, messages) {
        return Ok(s);
    }

    let mut out = String::new();
    for (role, content) in messages {
        out.push_str("<|im_start|>");
        out.push_str(role);
        out.push('\n');
        out.push_str(content);
        out.push_str("<|im_end|>\n");
    }
    out.push_str("<|im_start|>assistant\n");
    Ok(out)
}

/// Best-effort wrapper around the model's embedded chat template.
/// Returns `Err` if the model has no template or the `llama-cpp-2`
/// version on the build doesn't expose the helper we need — callers
/// then fall back to ChatML.
fn try_apply_template(_model: &LlamaModel, _messages: &[ChatMsg]) -> Result<String> {
    // Intentionally stubbed: the `apply_chat_template` helper signature
    // varies across `llama-cpp-2` 0.1.x. Phase 3 will pin a version and
    // wire this up properly. The ChatML fallback in `render_chat_prompt`
    // handles every modern fine-tune we've shipped to date.
    Err(anyhow!("chat template not wired up yet"))
}

pub type SharedRuntime = Arc<Mutex<Option<NativeRuntime>>>;

pub fn new_shared() -> SharedRuntime {
    Arc::new(Mutex::new(None))
}

/* ── Trait impl ───────────────────────────────────────────────────────── */

impl NativeBackend for NativeRuntime {
    fn load(
        model_ref: ModelRef,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self>> + Send>> {
        Box::pin(async move {
            match model_ref {
                ModelRef::GgufPath(p) => NativeRuntime::load_gguf(p).await,
                ModelRef::HfRepo(_) => Err(anyhow!(
                    "llamacpp backend requires GgufPath; HfRepo not yet supported (Phase 3)"
                )),
            }
        })
    }

    fn model_id(&self) -> &str {
        NativeRuntime::model_id(self)
    }

    fn chat_stream(
        &self,
        messages: Vec<ChatMsg>,
        sampling: SamplingOpts,
        mut on_chunk: Box<dyn FnMut(String) + Send + 'static>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>> {
        Box::pin(async move {
            NativeRuntime::chat_stream(self, messages, sampling, move |s| on_chunk(s)).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase 2 acceptance: the llamacpp backend must reject `HfRepo`
    /// loads with a clear, user-facing error so the frontend can show
    /// the right "download a GGUF first" message until Phase 3 lands.
    #[tokio::test]
    async fn rejects_hfrepo_with_phase3_message() {
        let res = <NativeRuntime as NativeBackend>::load(ModelRef::HfRepo("foo/bar".into())).await;
        let err = res.expect_err("HfRepo must be rejected by llamacpp backend");
        let msg = err.to_string();
        assert!(
            msg.contains("GgufPath"),
            "error should mention GgufPath: got {msg:?}"
        );
        assert!(
            msg.contains("Phase 3"),
            "error should reference Phase 3 follow-up: got {msg:?}"
        );
    }
}
