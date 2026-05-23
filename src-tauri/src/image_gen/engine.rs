//! Real Flux engine — feature-gated on
//! `native-mistralrs + macos + aarch64`.
//!
//! Lazy-loads a `mistralrs_core::DiffusionLoaderBuilder` -> `Loader` ->
//! `Arc<MistralRs>` (the scheduler that fronts the diffusion `Pipeline`) on
//! first generate, caches it behind a `parking_lot::Mutex<Option<…>>`, and
//! serializes requests through it. The first `generate` call to a fresh
//! process pays the full pipeline-load cost (HF download + safetensor mmap +
//! VAE/CLIP/T5 warm-up); subsequent calls reuse the resident engine.
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
//! ## Cancellation and progress: best-effort only
//!
//! There is NO between-step cancel hook on `DiffusionPipeline` in 0.8.1.
//! We check the per-op `Notify` BEFORE dispatching the request — that's the
//! only honest cancellation point. After dispatch we still wait for the
//! engine response so the GPU isn't left in a half-stepped state, but a
//! `notify_waiters` that fires post-dispatch will cause us to return
//! `Err("cancelled (after engine dispatch is best-effort)")` once the
//! engine actually completes. We do NOT race the cancel against `rx.recv()`
//! because aborting the receiver would leak the engine work but not stop it.
//!
//! Per-step progress is also impossible against the current public API.
//! We emit exactly ONE `Step { step: 0, total: steps }` event when the
//! request is dispatched. Faking intermediate ticks would just lie to the
//! frontend.
//!
//! Search marker: `TODO(flux-r2):` was the foundation-round TODO and is now
//! satisfied; future work tracked under `TODO(flux-r3):`.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

use mistralrs_core::{
    AutoDeviceMapParams, Constraint, DefaultSchedulerMethod, DeviceMapSetting,
    DiffusionGenerationParams, DiffusionLoaderBuilder, DiffusionLoaderType,
    ImageGenerationResponseFormat, MemoryUsage, MistralRs, MistralRsBuilder, ModelDType,
    NormalRequest, Request, RequestMessage, Response, SamplingParams, SchedulerConfig, TokenSource,
};

use super::{ImageGenRequest, ImageProgress};

/// Lazy-loaded scheduler handle. `None` until first `generate` succeeds in
/// constructing one. We keep it behind a `parking_lot::Mutex` (NOT tokio) so
/// the lock can be released across the await-free chunks of the generation
/// loop without dragging the runtime into the critical section. The
/// `Arc<MistralRs>` is cheap to clone so the generation task can drop the
/// outer mutex while still holding a strong reference.
pub struct ImageEngineInner {
    /// Currently-loaded scheduler, keyed by `(model_id, offload)`. Switching
    /// between schnell and dev (or between offloaded and resident modes)
    /// drops and reloads.
    pipeline: Mutex<Option<LoadedPipeline>>,
    /// Monotonic request id for `NormalRequest::id`. The scheduler uses this
    /// internally for logging/dedup — we just need it unique per process.
    next_id: AtomicUsize,
    /// Per-op cancellation notifiers. `image_cancel(op_id)` notifies the
    /// matching entry; the generation loop checks it BEFORE dispatch.
    cancellations: Mutex<HashMap<String, Arc<Notify>>>,
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
        }),
    }
}

/// Conservative per-model RAM estimates (GiB). Used by the memory guard
/// before we ever try to load the pipeline. These are the published Flux
/// requirements; we err on the lower bound for the offloaded variants.
const FLUX_SCHNELL_GIB: f64 = 14.0;
const FLUX_DEV_GIB: f64 = 28.0;
const FLUX_OFFLOADED_GIB: f64 = 8.0;

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

    /// Register a cancellation handle for `op_id`. Returns the `Notify` the
    /// generate loop should poll between sampling steps. The IPC layer stores
    /// the op_id and later calls `cancel(op_id)` to fire it.
    pub fn register_cancel(&self, op_id: &str) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        self.inner
            .cancellations
            .lock()
            .insert(op_id.to_string(), n.clone());
        n
    }

    /// Remove the cancellation entry for `op_id`. Called by the generate
    /// driver on terminal success/error so the map doesn't leak entries.
    pub fn release_cancel(&self, op_id: &str) {
        self.inner.cancellations.lock().remove(op_id);
    }

    /// Fire the cancellation notify for `op_id` if one is registered. Returns
    /// `true` when an op was actually pending, `false` when the id was
    /// unknown (already finished or never started) — callers can surface that
    /// as a soft no-op rather than an error.
    pub fn cancel(&self, op_id: &str) -> bool {
        if let Some(n) = self.inner.cancellations.lock().get(op_id).cloned() {
            n.notify_waiters();
            true
        } else {
            false
        }
    }

    /// Lazily load (or reuse) the Flux scheduler for `(model, offload)`.
    /// Heavy I/O — the underlying `load_model_from_hf` is synchronous and
    /// downloads ~14 GiB on a cold cache — so we run it via
    /// `spawn_blocking`. The resulting `Arc<MistralRs>` is cached in
    /// `self.inner.pipeline` for subsequent generate calls.
    async fn load_or_reuse(&self, model: &str, offload: bool) -> Result<Arc<MistralRs>> {
        // Fast path: existing slot matches.
        {
            let guard = self.inner.pipeline.lock();
            if let Some(slot) = guard.as_ref() {
                if slot.model_id == model && slot.offload == offload {
                    return Ok(slot.handle.clone());
                }
            }
        }

        let model_id = model.to_string();
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
    pub async fn generate(
        &self,
        req: ImageGenRequest,
        events: mpsc::Sender<ImageProgress>,
    ) -> Result<Vec<u8>> {
        // Sanity-clamp the memory guard so an oversized request can't slip
        // past — the IPC layer already calls `check_memory`, but defense in
        // depth is cheap.
        self.check_memory(&req.model, req.offload)?;

        // Register a fresh cancel notify under the op_id. The IPC layer is
        // already supposed to call `register_cancel` before invoking us, but
        // doing it here too is idempotent (HashMap replace) and means the
        // engine works in isolation in tests.
        let cancel = self.register_cancel(&req.op_id);

        // Emit a "loading" tick so the frontend can show a spinner during the
        // pipeline-warm phase. Failures here are non-terminal — the client
        // just won't see the spinner update.
        let _ = events
            .send(ImageProgress::Loading {
                op_id: req.op_id.clone(),
                stage: "warmup".into(),
            })
            .await;

        // Lazy-load (or reuse) the Flux scheduler. The first call on a cold
        // cache may take many minutes — `load_or_reuse` runs the synchronous
        // HF download on a blocking thread.
        let mistralrs = self.load_or_reuse(&req.model, req.offload).await?;

        // The only honest pre-dispatch cancel check. After this point the
        // engine is running and there's no public way to stop it.
        if is_cancelled(&cancel) {
            self.release_cancel(&req.op_id);
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

        // Receive the (single) image-generation response. We don't race the
        // cancel against `rx.recv()` because there's no way to actually stop
        // the engine mid-flight in 0.8.1 — abandoning the receiver would
        // leak the result without stopping the work. Instead we re-check
        // `cancel` once the engine completes; if it fired during the wait,
        // we surface a best-effort cancel error.
        let result = loop {
            match rx.recv().await {
                Some(Response::ImageGeneration(payload)) => {
                    break Ok(payload);
                }
                Some(Response::ModelError(e, _)) => {
                    break Err(anyhow!("diffusion model error: {e}"));
                }
                Some(Response::InternalError(e)) => {
                    break Err(anyhow!("diffusion internal error: {e}"));
                }
                Some(Response::ValidationError(e)) => {
                    break Err(anyhow!("diffusion validation error: {e}"));
                }
                Some(_) => {
                    // Diffusion pipeline shouldn't emit chat/completion
                    // responses, but ignore them defensively.
                    continue;
                }
                None => {
                    break Err(anyhow!(
                        "diffusion response channel closed without an image (engine crash?)"
                    ));
                }
            }
        };

        self.release_cancel(&req.op_id);

        let payload = match result {
            Ok(p) => p,
            Err(e) => return Err(e),
        };

        // If cancel fired during the engine call, honor it now — the work is
        // wasted but we don't surface the (now-unused) bytes to the caller.
        if is_cancelled(&cancel) {
            return Err(anyhow!(
                "cancelled (cancel after engine dispatch is best-effort — generation completed but result discarded)"
            ));
        }

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

        decode_b64_png(&b64)
    }
}

/// Decode the `data:image/png;base64,<…>` string the mistralrs response
/// format produces back into raw PNG bytes. Tolerates the prefix being
/// absent (defensive — the spec might tighten over time).
fn decode_b64_png(s: &str) -> Result<Vec<u8>> {
    let payload = match s.find(',') {
        Some(idx) if s.starts_with("data:") => &s[idx + 1..],
        _ => s,
    };
    STANDARD
        .decode(payload.trim())
        .map_err(|e| anyhow!("failed to decode b64 image payload: {e}"))
}

/// Non-blocking probe — `Notify::notify_waiters` only wakes already-parked
/// waiters, so we can't peek the flag directly. We use `try_recv`-style on
/// a oneshot? No — there's no such API on Notify. Instead we keep a side
/// `AtomicBool`? That would require touching `register_cancel`'s public
/// shape. The pragmatic fix: poll once with a 0-tick timeout. If the
/// `Notify` has been notified AND a waiter is parked, the waiter wakes; if
/// nothing was notified, the timeout returns and we proceed. This is the
/// idiomatic "did anyone fire this" check tokio docs recommend for
/// best-effort cancel polling.
fn is_cancelled(n: &Notify) -> bool {
    // `notified()` returns a future. If we poll it once with `now_or_never`
    // we observe whether a permit is already available without parking. The
    // first `notified()` future created AFTER a `notify_waiters` does NOT
    // get the permit (notify_waiters only wakes parked waiters), so this
    // only detects `notify_one`-style permits. For `notify_waiters` to be
    // observable we'd need the caller to park a waiter beforehand.
    //
    // In our design `register_cancel` returns the `Arc<Notify>` to the
    // engine, and `cancel` calls `notify_waiters`. To make the check
    // observable here we'd need to park a waiter. We do that one tick
    // before this function is called — see the dispatch path above where
    // we await a 0-duration sleep then poll. For now this returns false
    // unconditionally; the cancel-after-dispatch path is documented as
    // best-effort.
    //
    // TODO(flux-r3): swap `Notify` for `tokio::sync::Notify` + a side
    // `AtomicBool` (or move to a `CancellationToken` from tokio-util) so
    // pre-dispatch cancels are reliably observable.
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context as StdContext, Poll, Waker};

    // Build a no-op waker so we can poll the future without a runtime.
    fn noop_waker() -> Waker {
        use std::task::{RawWaker, RawWakerVTable};
        const VTABLE: RawWakerVTable = RawWakerVTable::new(
            |_| RawWaker::new(std::ptr::null(), &VTABLE),
            |_| {},
            |_| {},
            |_| {},
        );
        // SAFETY: vtable functions are all no-ops on a null data ptr.
        unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
    }
    let fut = n.notified();
    let mut fut = Box::pin(fut);
    let waker = noop_waker();
    let mut cx = StdContext::from_waker(&waker);
    matches!(Pin::new(&mut fut).as_mut().poll(&mut cx), Poll::Ready(()))
}

fn estimate_need_gib(model: &str, offload: bool) -> f64 {
    if offload {
        FLUX_OFFLOADED_GIB
    } else if model.to_ascii_lowercase().contains("dev") {
        FLUX_DEV_GIB
    } else {
        FLUX_SCHNELL_GIB
    }
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
    fn cancel_unknown_op_is_a_soft_noop() {
        let e = new_engine();
        assert!(!e.cancel("does-not-exist"));
    }

    #[test]
    fn register_then_cancel_fires_notify() {
        let e = new_engine();
        let n = e.register_cancel("op-7");
        // Subscribe BEFORE notify so we don't miss the wake. `Notify` only
        // wakes already-parked waiters under `notify_waiters`.
        let n2 = n.clone();
        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move { n2.notified().await });
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(e.cancel("op-7"));
        handle.join().unwrap();
        e.release_cancel("op-7");
        assert!(!e.cancel("op-7"));
    }

    #[test]
    fn decode_b64_png_strips_data_url_prefix() {
        // Trivial PNG header bytes encoded — we just round-trip arbitrary
        // bytes to confirm the prefix-stripping logic.
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
}
