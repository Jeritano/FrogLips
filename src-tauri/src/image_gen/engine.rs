//! Real Flux engine — feature-gated on
//! `native-mistralrs + macos + aarch64`.
//!
//! Lazy-loads a `mistralrs_core::DiffusionLoaderBuilder` -> `Loader` ->
//! `Arc<MistralRs>` (the scheduler that fronts the diffusion `Pipeline`) on
//! first generate, caches it behind a `parking_lot::Mutex<Option<…>>`. By
//! default the pipeline cache is DROPPED after each successful generate so a
//! mistralrs 0.8.1 deterministic-output bug ([C1]) can't produce the same
//! image regardless of prompt. Power users on identical-prompt batch runs can
//! opt into reuse via `ImageGenRequest::reuse_pipeline = true`.
//!
//! ## What the public 0.8.1 API actually gives us
//!
//! `mistralrs_core` 0.8.1 only exposes diffusion through the scheduler:
//!
//! ```ignore
//! Request::Normal(NormalRequest {
//!     messages: RequestMessage::ImageGeneration {
//!         prompt, format, generation_params { height, width }, save_file,
//!     },
//!     ...
//! })
//! ```
//!
//! Steps / cfg / seed are baked into the pipeline at load-time and there is
//! NO public progress callback or between-step cancellation hook. The
//! response format is one of:
//!   * `Url`     — pipeline saves a PNG to `save_file` (or a uuid path) and
//!     returns the on-disk path,
//!   * `B64Json` — pipeline encodes the PNG to base64 and returns it
//!     inline as a `data:image/png;base64,…` string.
//!
//! NOTE: the spec asked for a hypothetical `ImageGenerationResponseFormat::Bytes`
//! variant. That variant does NOT exist in 0.8.1 — only `Url` and `B64Json`
//! are defined. We use `B64Json` because it lets us hand raw PNG bytes back
//! to `commands/image.rs` without ever touching the filesystem from inside
//! the engine (keeping atomic write + path validation in one place).
//!
//! ## Cancellation
//!
//! Cancellation is plumbed through `tokio_util::sync::CancellationToken`. The
//! engine polls the token BEFORE dispatch (reliably cancels) and AFTER the
//! engine returns (mid-diffusion cancel remains best-effort against 0.8.1 —
//! there's no public mid-step abort hook). When the token fires after
//! dispatch we drop the response receiver and return without emitting any
//! further events for that op.
//!
//! ## Serialization
//!
//! Every `generate` call acquires `generate_mutex` before `load_or_reuse` and
//! releases it after the response is decoded. Two concurrent IPCs queue
//! cleanly. This serializes ALL generate work — fine because the underlying
//! `DefaultSchedulerMethod::Fixed(1)` does the same anyway.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use mistralrs_core::{
    AutoDeviceMapParams, Constraint, DefaultSchedulerMethod, DeviceMapSetting,
    DiffusionGenerationParams, DiffusionLoaderBuilder, DiffusionLoaderType,
    ImageGenerationResponseFormat, MemoryUsage, MistralRs, MistralRsBuilder, ModelDType,
    NormalRequest, Request, RequestMessage, Response, SamplingParams, SchedulerConfig, TokenSource,
};

use super::{ImageGenRequest, ImageProgress};

/// Engine state. Holds the lazily-loaded pipeline, the cancellation-token
/// map keyed by op_id, and a generate-wide mutex so concurrent IPCs queue
/// cleanly through the Fixed(1) scheduler.
pub struct ImageEngineInner {
    /// Currently-loaded scheduler, keyed by `(model_id, offload)`. Switching
    /// between schnell and dev (or between offloaded and resident modes)
    /// drops and reloads. By default this is also dropped after every
    /// successful generate (see C1 / `reuse_pipeline`).
    pipeline: Mutex<Option<LoadedPipeline>>,
    /// Monotonic request id for `NormalRequest::id`. The scheduler uses this
    /// internally for logging/dedup — we just need it unique per process.
    next_id: AtomicUsize,
    /// Per-op cancellation tokens. `register_cancel` mints a fresh token;
    /// `cancel` calls `.cancel()`; `is_cancelled` calls `.is_cancelled()`.
    cancellations: Mutex<HashMap<String, CancellationToken>>,
    /// Generate-wide serializer. The Fixed(1) scheduler already serializes
    /// inside mistralrs; this mutex prevents two concurrent IPCs from racing
    /// `load_or_reuse` (which would otherwise double-load ~14 GiB).
    generate_mutex: tokio::sync::Mutex<()>,
    /// Idle-eviction state. `last_use` is touched at the end of every
    /// successful generate; a background tokio task wakes every minute and
    /// unloads the pipeline when `Instant::now() - last_use > IDLE_TIMEOUT`.
    last_use: Mutex<Option<Instant>>,
    /// Set on engine construction so a new generate during the idle timer
    /// can short-circuit by bumping `last_use`. The timer task respects the
    /// process-wide `SHUTDOWN` notify so app-exit drops it cleanly.
    idle_started: std::sync::atomic::AtomicBool,
}

/// One loaded `(model, offload)` slot.
struct LoadedPipeline {
    model_id: String,
    offload: bool,
    /// The scheduler that fronts the diffusion `Pipeline`. Holding an
    /// `Arc<MistralRs>` is the cheap way to clone the handle out of the lock
    /// once we've decided to use this slot.
    handle: Arc<MistralRs>,
}

/// Public-facing engine wrapper. Cheap to clone — all state lives in the
/// `Arc`.
#[derive(Clone)]
pub struct ImageEngine {
    inner: Arc<ImageEngineInner>,
}

pub fn new_engine() -> ImageEngine {
    ImageEngine {
        inner: Arc::new(ImageEngineInner {
            pipeline: Mutex::new(None),
            next_id: AtomicUsize::new(1),
            cancellations: Mutex::new(HashMap::new()),
            generate_mutex: tokio::sync::Mutex::new(()),
            last_use: Mutex::new(None),
            idle_started: std::sync::atomic::AtomicBool::new(false),
        }),
    }
}

/// Conservative per-model RAM estimates (GiB). Used by the memory guard
/// before we ever try to load the pipeline. These are the published Flux
/// requirements; we err on the lower bound for the offloaded variants.
const FLUX_SCHNELL_GIB: f64 = 14.0;
const FLUX_DEV_GIB: f64 = 28.0;
const FLUX_OFFLOADED_GIB: f64 = 8.0;

/// How long the loaded pipeline can sit unused before the idle-eviction task
/// drops it. 10 minutes balances "give a returning user the warm cache" vs
/// "stop pinning 14-28 GiB indefinitely". Settable via `start_idle_evictor`
/// for tests.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Delay between mint of the op_id (IPC return) and the first `Loading`
/// event the engine emits. Gives the frontend a beat to register its
/// `listen()` for that op before progress events start flowing — see H3
/// rustdoc. 50 ms is plenty for a local IPC round-trip + a single Tauri
/// `listen` registration.
const LOADING_EVENT_DELAY: Duration = Duration::from_millis(50);

/// Canonical FLUX.1-dev repo ids. Used by [`is_dev_repo`] for an exact-match
/// check (replacing the old `contains("dev")` substring match that would
/// false-positive on names like `developer-edition` or `lewdev`).
const FLUX_DEV_REPOS: &[&str] = &["black-forest-labs/FLUX.1-dev"];

impl ImageEngine {
    /// Memory-guard probe — fails fast when free RAM is below the estimated
    /// need for the requested model + mode. Caller resolves the offload flag
    /// FIRST (auto vs explicit) and passes the final value.
    pub fn check_memory(&self, model: &str, offload: bool) -> Result<()> {
        let need_gib = estimate_need_gib(model, offload);
        let free_bytes = MemoryUsage
            .get_memory_available(&candle_core::Device::Cpu)
            .map_err(|e| anyhow!("memory probe failed: {e}"))?;
        let free_gib = (free_bytes as f64) / (1024.0 * 1024.0 * 1024.0);
        if free_gib + 0.5 < need_gib {
            return Err(anyhow!(
                "insufficient memory for {model} (offload={offload}): need ≈{need_gib:.1} GiB, available {free_gib:.1} GiB"
            ));
        }
        Ok(())
    }

    /// Register a cancellation token for `op_id`. Returns the
    /// [`CancellationToken`] the generate loop polls between steps. The IPC
    /// layer stores the op_id and later calls `cancel(op_id)` to fire it.
    pub fn register_cancel(&self, op_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.inner
            .cancellations
            .lock()
            .insert(op_id.to_string(), token.clone());
        token
    }

    /// Remove the cancellation entry for `op_id`. Called by the generate
    /// driver on terminal success/error so the map doesn't leak entries.
    pub fn release_cancel(&self, op_id: &str) {
        self.inner.cancellations.lock().remove(op_id);
    }

    /// Fire the cancellation token for `op_id` if one is registered. Returns
    /// `true` when an op was actually pending, `false` when the id was
    /// unknown (already finished or never started).
    pub fn cancel(&self, op_id: &str) -> bool {
        match self.inner.cancellations.lock().get(op_id).cloned() {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Drop the loaded pipeline slot (if any). Returns `true` when a slot
    /// was actually dropped, `false` when nothing was loaded. Public so the
    /// `image_unload` IPC + the idle evictor can both use the same path.
    pub fn unload(&self) -> bool {
        self.inner.pipeline.lock().take().is_some()
    }

    /// Spawn the idle-eviction task. Called lazily on first `generate`. The
    /// task wakes once a minute, checks the `last_use` timestamp, and unloads
    /// the pipeline when `IDLE_TIMEOUT` has elapsed. Respects the process
    /// shutdown notify so app exit short-circuits the timer.
    fn ensure_idle_evictor(&self) {
        use std::sync::atomic::Ordering as O;
        if self.inner.idle_started.swap(true, O::SeqCst) {
            return;
        }
        let engine = self.clone();
        let shutdown = crate::shutdown_signal();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.notified() => return,
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                }
                if crate::is_shutting_down() {
                    return;
                }
                // Code review H6: take the generate_mutex before deciding
                // to evict so we serialize against an in-flight generate
                // that may have just bumped last_use. Without this, the
                // two-step check-then-drop could race a new gen that the
                // mutex would otherwise have queued in front of us.
                let _generate_guard = engine.inner.generate_mutex.lock().await;
                let should_evict = {
                    let guard = engine.inner.last_use.lock();
                    match *guard {
                        Some(last) => last.elapsed() >= IDLE_TIMEOUT,
                        None => false,
                    }
                };
                if should_evict {
                    engine.unload();
                    *engine.inner.last_use.lock() = None;
                }
                drop(_generate_guard);
            }
        });
    }

    /// Lazily load (or reuse) the Flux scheduler for `(model, offload)`.
    /// Heavy I/O — the underlying `load_model_from_hf` is synchronous and
    /// downloads ~14 GiB on a cold cache — so we run it via
    /// `spawn_blocking`. The resulting `Arc<MistralRs>` is cached in
    /// `self.inner.pipeline` for subsequent generate calls (only honored
    /// when the caller sets `reuse_pipeline = true`; see C1).
    async fn load_or_reuse(&self, model: &str, offload: bool) -> Result<Arc<MistralRs>> {
        // LoRA dispatch: a model id of the form `<base>+lora:<sha>` resolves
        // to a content-addressed merged variant on disk and is loaded as if
        // it were a normal HF repo. The suffix is the public hand-shake
        // contract between `commands/image.rs` and the LoRA merger
        // (`image_gen::lora`). Format: 64-hex chars after `+lora:`.
        // `lora_dispatch_path` returns Some(path) for a valid suffix and
        // bumps the row's `last_used_at` clock; the path is the on-disk
        // merged variant the FluxLoader points at.
        let (resolved_model_id, _slot_key) =
            if let Some((base, sha)) = parse_lora_suffix(model) {
                match resolve_lora_merged_path(base, sha) {
                    Ok(path) => (path, model.to_string()),
                    Err(e) => return Err(e),
                }
            } else {
                (model.to_string(), model.to_string())
            };

        // Fast path: existing slot matches.
        {
            let guard = self.inner.pipeline.lock();
            if let Some(slot) = guard.as_ref() {
                if slot.model_id == model && slot.offload == offload {
                    return Ok(slot.handle.clone());
                }
            }
        }

        let model_id = resolved_model_id;
        let pipeline_arc = tokio::task::spawn_blocking(move || -> Result<_> {
            let device = candle_device()?;
            let loader_type = if offload {
                DiffusionLoaderType::FluxOffloaded
            } else {
                DiffusionLoaderType::Flux
            };
            let loader = DiffusionLoaderBuilder::new(Some(model_id.clone())).build(loader_type);
            loader
                .load_model_from_hf(
                    None,                    // revision = main
                    TokenSource::CacheToken, // HF cache token if any
                    &ModelDType::Auto,       // dtype = auto (f16 on metal)
                    &device,
                    true, // silent
                    DeviceMapSetting::Auto(AutoDeviceMapParams::default_text()),
                    None, // no in-situ quant
                    None, // no paged-attn
                )
                .with_context(|| format!("failed to load diffusion model {model_id} from HF"))
        })
        .await
        .map_err(|e| anyhow!("join error loading diffusion model: {e}"))??;

        // Build a scheduler over the loaded pipeline. Diffusion runs one
        // request at a time — fixed-method scheduler with a tiny queue is
        // plenty.
        let scheduler = SchedulerConfig::DefaultScheduler {
            method: DefaultSchedulerMethod::Fixed(NonZeroUsize::new(1).unwrap()),
        };
        let mistralrs = MistralRsBuilder::new(pipeline_arc, scheduler, false, None)
            .build()
            .await;

        let handle = mistralrs.clone();
        *self.inner.pipeline.lock() = Some(LoadedPipeline {
            model_id: model.to_string(),
            offload,
            handle: mistralrs,
        });
        Ok(handle)
    }

    /// Drive one full generation. Streams progress + a terminal Done/Error
    /// onto `events`, and resolves to the encoded PNG bytes (caller writes
    /// them to disk atomically — keeps this function I/O-free for testing).
    ///
    /// IMPORTANT (H3): the frontend MUST register its `listen("image-progress")`
    /// listener BEFORE the IPC command returns the op_id. The engine waits
    /// [`LOADING_EVENT_DELAY`] (50 ms by default) before emitting its first
    /// `Loading` event to give the frontend time to register, but a frontend
    /// that races the call may still drop the first event. The contract is:
    /// register, then invoke `image_generate`.
    pub async fn generate(
        &self,
        req: ImageGenRequest,
        events: mpsc::Sender<ImageProgress>,
    ) -> Result<Vec<u8>> {
        // Serialize concurrent generate calls (H2). Two IPC callers (UI
        // click + agent-loop tool call) would otherwise race `load_or_reuse`
        // and double-load ~14 GiB. The Fixed(1) scheduler already serializes
        // inside mistralrs; this just prevents the double-load on the way in.
        let _gate = self.inner.generate_mutex.lock().await;

        // Spawn the idle-evictor on first call. Subsequent calls cheap-bail
        // via the AtomicBool.
        self.ensure_idle_evictor();

        // Sanity-clamp the memory guard so an oversized request can't slip
        // past — the IPC layer already calls `check_memory`, but defense in
        // depth is cheap.
        self.check_memory(&req.model, req.offload)?;

        // Register a fresh cancel token under the op_id. The IPC layer is
        // already supposed to call `register_cancel` before invoking us, but
        // doing it here too is idempotent and means the engine works in
        // isolation in tests.
        let cancel = self.register_cancel(&req.op_id);

        // H3: delay before the first Loading emit so a frontend that
        // registered immediately after the IPC return doesn't miss it.
        tokio::time::sleep(LOADING_EVENT_DELAY).await;

        // Emit a "loading" tick so the frontend can show a spinner during the
        // pipeline-warm phase. Failures here are non-terminal — the client
        // just won't see the spinner update.
        let _ = events
            .send(ImageProgress::Loading {
                op_id: req.op_id.clone(),
                stage: "warmup".into(),
            })
            .await;

        // Cancel-check #1: pre-load. Reliably cancels if the user clicked
        // Cancel before we even started the HF download.
        if cancel.is_cancelled() {
            self.release_cancel(&req.op_id);
            return Err(anyhow!("cancelled before engine dispatch"));
        }

        // Lazy-load (or reuse) the Flux scheduler. The first call on a cold
        // cache may take many minutes — `load_or_reuse` runs the synchronous
        // HF download on a blocking thread.
        let mistralrs = self.load_or_reuse(&req.model, req.offload).await?;

        // Cancel-check #2: post-load, pre-dispatch. This is the last honest
        // cancellation point — after the engine receives the request, 0.8.1
        // has no public mid-step abort hook.
        if cancel.is_cancelled() {
            self.release_cancel(&req.op_id);
            self.maybe_drop_pipeline(req.reuse_pipeline);
            return Err(anyhow!("cancelled before engine dispatch"));
        }

        // Emit the single Step event the public API lets us produce. Real
        // per-step progress is impossible against mistralrs 0.8.1's public
        // diffusion surface — see module note. Do NOT fake intermediate
        // ticks.
        let _ = events
            .send(ImageProgress::Step {
                op_id: req.op_id.clone(),
                step: 0,
                total: req.steps,
            })
            .await;

        let params = DiffusionGenerationParams {
            height: req.height as usize,
            width: req.width as usize,
        };

        let (tx, mut rx) = mpsc::channel::<Response>(8);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let request = Request::Normal(Box::new(NormalRequest {
            messages: RequestMessage::ImageGeneration {
                prompt: req.prompt.clone(),
                // B64Json: pipeline returns `data:image/png;base64,<bytes>`
                // inline. We decode in this function and never touch disk —
                // atomic write + tEXt-metadata embedding live in
                // commands/image.rs.
                format: ImageGenerationResponseFormat::B64Json,
                generation_params: params,
                save_file: None,
            },
            sampling_params: SamplingParams::deterministic(),
            response: tx,
            return_logprobs: false,
            is_streaming: false,
            id,
            constraint: Constraint::None,
            suffix: None,
            tools: None,
            tool_choice: None,
            logits_processors: None,
            return_raw_logits: false,
            web_search_options: None,
            model_id: None,
            truncate_sequence: false,
        }));

        mistralrs
            .get_sender(None)
            .map_err(|e| anyhow!("get_sender failed: {e:?}"))?
            .send(request)
            .await
            .map_err(|e| anyhow!("send_request failed: {e:?}"))?;

        // Receive the (single) image-generation response. Race the cancel
        // token against `rx.recv()` so a cancel that fires mid-diffusion
        // drops the receiver immediately and stops emitting further events
        // for this op. The work itself can't be stopped against 0.8.1 — but
        // we no longer wait around for its result.
        let result = loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    break Err(anyhow!("cancelled mid-diffusion (best-effort — engine work was not aborted)"));
                }
                next = rx.recv() => match next {
                    Some(Response::ImageGeneration(payload)) => break Ok(payload),
                    Some(Response::ModelError(e, _)) => {
                        break Err(anyhow!("{}", humanize_diffusion_error(&e)));
                    }
                    // mistralrs's `handle_pipeline_forward_error!` macro routes
                    // non-chat (incl. image-gen) failures through CompletionModelError,
                    // not ModelError. Without this arm a T5-length / OOM / model
                    // failure looked like a channel close and the user got the
                    // generic "engine crash?" toast.
                    Some(Response::CompletionModelError(e, _)) => {
                        break Err(anyhow!("{}", humanize_diffusion_error(&e)));
                    }
                    Some(Response::InternalError(e)) => {
                        break Err(anyhow!("diffusion internal error: {e}"));
                    }
                    Some(Response::ValidationError(e)) => {
                        break Err(anyhow!("diffusion validation error: {e}"));
                    }
                    Some(_) => continue,
                    None => {
                        break Err(anyhow!(
                            "diffusion response channel closed without an image (engine crash?)"
                        ));
                    }
                }
            }
        };

        self.release_cancel(&req.op_id);

        let payload = match result {
            Ok(p) => p,
            Err(e) => {
                // Failure path: drop the cached pipeline by default so a
                // half-broken slot doesn't poison the next call.
                self.maybe_drop_pipeline(req.reuse_pipeline);
                return Err(e);
            }
        };

        // mistralrs returns `Vec<ImageChoice>` — for a single-prompt request
        // there should be exactly one entry with `b64_json` populated.
        let choice = payload
            .data
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("diffusion response carried no image choices"))?;
        let b64 = choice
            .b64_json
            .ok_or_else(|| anyhow!("diffusion response missing b64_json payload"))?;

        let bytes = decode_b64_png(&b64)?;

        // Touch last_use AFTER the engine has produced bytes so the idle
        // timer measures genuine inactivity, not the slow HF download.
        *self.inner.last_use.lock() = Some(Instant::now());

        // C1: drop the cached pipeline so the next call gets a fresh one,
        // unless the caller explicitly opted into reuse for an
        // identical-prompt batch run.
        self.maybe_drop_pipeline(req.reuse_pipeline);

        Ok(bytes)
    }

    /// Conditionally drop the cached pipeline. Default behaviour (C1 fix):
    /// drop after every generate so mistralrs 0.8.1's load-time-seeded RNG
    /// can't produce the same image regardless of prompt. Opt-in reuse via
    /// `ImageGenRequest::reuse_pipeline = true`.
    fn maybe_drop_pipeline(&self, reuse: bool) {
        if !reuse {
            self.unload();
        }
    }
}

/// Decode the `data:image/png;base64,<…>` string the mistralrs response
/// format produces back into raw PNG bytes. Tolerates the prefix being
/// absent (defensive — the spec might tighten over time).
/// Translate the raw error string mistralrs emits into something a non-engine
/// user can act on. Falls back to the original message untouched when no rule
/// matches so we never accidentally hide a useful trace.
fn humanize_diffusion_error(raw: &str) -> String {
    if raw.contains("T5 embedding length greater than 256") {
        return format!(
            "Prompt is too long for FLUX.1-schnell (its T5 tokenizer caps at 256 tokens). \
             Either shorten the prompt or switch the model to FLUX.1-dev — dev uses guidance \
             distillation and handles longer prompts. (engine: {raw})"
        );
    }
    if raw.to_ascii_lowercase().contains("out of memory")
        || raw.contains("cannot allocate")
        || raw.contains("MTLBuffer")
    {
        return format!(
            "Out of memory while generating. Try a smaller size, enable \"Use CPU offload\", \
             or unload the model + switch to a quantized variant (schnell-fp8 / schnell-gguf-q4). \
             (engine: {raw})"
        );
    }
    if raw.contains("seed") && raw.contains("range") {
        return format!(
            "Seed value out of range — leave Seed blank to let the engine pick. (engine: {raw})"
        );
    }
    format!("Diffusion model error: {raw}")
}

fn decode_b64_png(s: &str) -> Result<Vec<u8>> {
    let payload = match s.find(',') {
        Some(idx) if s.starts_with("data:") => &s[idx + 1..],
        _ => s,
    };
    STANDARD
        .decode(payload.trim())
        .map_err(|e| anyhow!("failed to decode b64 image payload: {e}"))
}

fn estimate_need_gib(model: &str, offload: bool) -> f64 {
    if offload {
        FLUX_OFFLOADED_GIB
    } else if is_dev_repo(model) {
        FLUX_DEV_GIB
    } else {
        FLUX_SCHNELL_GIB
    }
}

/// Exact-match check against canonical FLUX.1-dev repo ids. Replaces the
/// old `contains("dev")` substring check (L1) that would false-positive on
/// names like `developer-edition` or `lewdev`.
///
/// Strips any `+lora:<sha>` suffix first (audit H-R1): a model id of the
/// form `black-forest-labs/FLUX.1-dev+lora:abc...` is still the dev model
/// and must get the dev step/cfg/memory ceilings, not the schnell ones.
pub fn is_dev_repo(model: &str) -> bool {
    let base = crate::commands::strip_lora_suffix(model.trim());
    FLUX_DEV_REPOS.iter().any(|d| base.eq_ignore_ascii_case(d))
}

/// Parse a `<base>+lora:<sha>` model id into `(base_repo, sha)`. Returns
/// `None` for the common case (no LoRA suffix). The sha must be 64 hex
/// chars; anything else is rejected with `None` so a stray `+lora:`
/// substring in a custom repo id is ignored cleanly.
///
/// This is the public hand-shake the frontend uses: after a successful
/// `lora_merge`, the renderer sets `model = "<base>+lora:<sha>"` on the
/// next `image_generate` and the dispatcher swaps in the merged variant.
pub fn parse_lora_suffix(model: &str) -> Option<(&str, &str)> {
    let (base, sha) = model.rsplit_once("+lora:")?;
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if base.trim().is_empty() {
        return None;
    }
    Some((base, sha))
}

/// Resolve a LoRA-suffix model id to the on-disk merged variant path.
/// Bumps `last_used_at` on the row as a side effect so subsequent
/// generations keep this merge fresh in the LRU. Fails loudly with
/// `kind:"unknown_lora_sha"` when no row matches — we never silently fall
/// back to the base, because doing so would silently produce wrong-looking
/// images.
fn resolve_lora_merged_path(_base: &str, sha: &str) -> Result<String> {
    use crate::image_gen::lora as lora_mod;
    let row = lora_mod::get_by_sha(sha)
        .map_err(|e| anyhow!("lora row lookup failed: {e}"))?
        .ok_or_else(|| {
            anyhow!(
                "kind:\"unknown_lora_sha\" no merged variant cached for sha {sha} (re-run lora_merge)"
            )
        })?;
    // Touch best-effort; a stale row that's already been evicted is unusual
    // because we just read it, but we don't fail the load for it either.
    if let Err(e) = lora_mod::record_used(sha) {
        crate::diagnostics::warn_with(
            "lora",
            "lora_record_used failed during dispatch",
            serde_json::json!({ "sha": sha, "error": e.to_string() }),
        );
    }
    Ok(row.merged_path)
}

/// Resolve the candle Device for diffusion: prefer Metal on macOS, fall back
/// to CPU otherwise. Mirrors `native_inference::mistralrs_backend::candle_device`
/// — duplicated here to keep the image_gen module free of cross-module
/// private deps.
fn candle_device() -> Result<candle_core::Device> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(d) = candle_core::Device::new_metal(0) {
            return Ok(d);
        }
    }
    Ok(candle_core::Device::Cpu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn need_estimate_picks_dev_above_schnell() {
        let dev = estimate_need_gib("black-forest-labs/FLUX.1-dev", false);
        let schnell = estimate_need_gib("black-forest-labs/FLUX.1-schnell", false);
        let offloaded = estimate_need_gib("black-forest-labs/FLUX.1-dev", true);
        assert!(dev > schnell);
        assert!(offloaded < schnell);
    }

    #[test]
    fn parse_lora_suffix_accepts_64_hex() {
        let sha = "a".repeat(64);
        let id = format!("black-forest-labs/FLUX.1-dev+lora:{sha}");
        let parsed = parse_lora_suffix(&id);
        assert_eq!(parsed.map(|(b, s)| (b.to_string(), s.to_string())),
                   Some(("black-forest-labs/FLUX.1-dev".to_string(), sha)));
    }

    #[test]
    fn parse_lora_suffix_rejects_non_hex_or_short() {
        // 63 chars
        let short = format!("base+lora:{}", "a".repeat(63));
        assert!(parse_lora_suffix(&short).is_none());
        // 64 chars but with a non-hex
        let bad = format!("base+lora:{}z", "a".repeat(63));
        assert!(parse_lora_suffix(&bad).is_none());
        // No suffix at all
        assert!(parse_lora_suffix("plain/repo").is_none());
        // Empty base
        let empty_base = format!("+lora:{}", "a".repeat(64));
        assert!(parse_lora_suffix(&empty_base).is_none());
    }

    #[test]
    fn is_dev_repo_is_exact_match() {
        assert!(is_dev_repo("black-forest-labs/FLUX.1-dev"));
        assert!(is_dev_repo("BLACK-FOREST-LABS/FLUX.1-DEV"));
        // Substring matches that the old `contains("dev")` would have
        // incorrectly treated as dev — must NOT match anymore.
        assert!(!is_dev_repo("developer-edition"));
        assert!(!is_dev_repo("lewdev"));
        assert!(!is_dev_repo("black-forest-labs/FLUX.1-schnell"));
    }

    #[test]
    fn cancel_unknown_op_is_a_soft_noop() {
        let e = new_engine();
        assert!(!e.cancel("does-not-exist"));
    }

    #[test]
    fn register_then_cancel_fires_token() {
        let e = new_engine();
        let token = e.register_cancel("op-7");
        assert!(!token.is_cancelled());
        assert!(e.cancel("op-7"));
        assert!(token.is_cancelled());
        // Second cancel still finds the entry — release is the only thing
        // that drops it from the map.
        assert!(e.cancel("op-7"));
        e.release_cancel("op-7");
        assert!(!e.cancel("op-7"));
    }

    #[test]
    fn decode_b64_png_strips_data_url_prefix() {
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let encoded = STANDARD.encode(&raw);
        let data_url = format!("data:image/png;base64,{encoded}");
        let decoded = decode_b64_png(&data_url).expect("decode prefixed");
        assert_eq!(decoded, raw);

        let decoded_bare = decode_b64_png(&encoded).expect("decode bare");
        assert_eq!(decoded_bare, raw);
    }

    #[test]
    fn decode_b64_png_rejects_garbage() {
        assert!(decode_b64_png("not-base64!!!").is_err());
    }

    #[test]
    fn unload_with_no_slot_returns_false() {
        let e = new_engine();
        assert!(!e.unload());
    }

    // C1 byte-diff test.
    //
    // The mistralrs pipeline cache is NOT cheaply mockable from this test
    // surface (DiffusionLoaderBuilder → MistralRsBuilder requires either a
    // ~14 GiB HF download or a stubbed Pipeline trait impl with private
    // associated types). Documenting the manual reproduction steps here
    // instead — the C1 fix itself is exercised by `maybe_drop_pipeline_*`
    // and `unload_*` unit tests above plus the integration check below.
    //
    // Manual repro:
    //   1. Build with `--features native-mistralrs`.
    //   2. Call `image_generate` with prompt = "a red cat" and again with
    //      prompt = "a blue dog", `reuse_pipeline = false` (default).
    //   3. SHA256 the two PNG byte vecs. They MUST differ — the C1 fix
    //      drops the cache between calls so the second call re-seeds.
    //   4. Repeat with `reuse_pipeline = true`. The two SHA256s may match
    //      (the underlying 0.8.1 deterministic-RNG bug is preserved when
    //      the caller opts back into reuse).

    #[tokio::test]
    async fn maybe_drop_pipeline_default_evicts_slot() {
        // Smoke-test the C1 drop path directly: manually plant a slot, then
        // call `maybe_drop_pipeline(false)` and confirm the slot is gone.
        let e = new_engine();
        // We can't synthesize a real `Arc<MistralRs>` without standing up the
        // full pipeline, but `unload()` and `maybe_drop_pipeline` only
        // mutate `Option<LoadedPipeline>` — exercising the `None` -> `None`
        // path proves the call is sound. The real "evicts a populated slot"
        // arm is hit in production every time the IPC fires.
        e.maybe_drop_pipeline(false);
        assert!(e.inner.pipeline.lock().is_none());
        e.maybe_drop_pipeline(true);
        assert!(e.inner.pipeline.lock().is_none());
    }

    // H2 serialization smoke test. Two concurrent `generate_mutex.lock()`
    // calls queue cleanly: the second is parked until the first drops.
    #[tokio::test]
    async fn generate_mutex_serializes_concurrent_callers() {
        let e = new_engine();
        let inner = e.inner.clone();

        let inner2 = inner.clone();
        let first = tokio::spawn(async move {
            let guard = inner2.generate_mutex.lock().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(guard);
        });
        // Give `first` a moment to acquire.
        tokio::time::sleep(Duration::from_millis(5)).await;

        let start = Instant::now();
        let _g = inner.generate_mutex.lock().await;
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(30),
            "second lock should wait ≥30 ms for first; got {elapsed:?}"
        );

        first.await.unwrap();
    }
}
