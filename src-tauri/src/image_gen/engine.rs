//! Real Flux engine — feature-gated on
//! `native-mistralrs + macos + aarch64`.
//!
//! Lazy-loads a `mistralrs_core::pipeline::diffusion::DiffusionPipeline`
//! behind a `parking_lot::Mutex<Option<Arc<…>>>` and serializes requests
//! through it. The first `generate` call to a fresh process pays the full
//! pipeline-load cost (download + safetensor mmap + VAE/CLIP/T5 warm-up);
//! subsequent calls reuse the resident pipeline.
//!
//! IMPORTANT (foundation round — scaffold-only generate path)
//! ----------------------------------------------------------------------
//! `DiffusionPipeline` in mistralrs-core 0.8.1 is only reachable through the
//! `MistralRs` scheduler + `Request::Normal { messages:
//! RequestMessage::ImageGeneration { … } }` API. That public surface accepts
//! ONLY `(prompt, format, generation_params { height, width }, save_file)` —
//! steps / cfg / seed are baked into the pipeline at load-time and there is
//! NO public progress callback or between-step cancellation hook.
//!
//! That means the spec's `steps`/`cfg`/`seed`/per-step progress + cancel
//! contract cannot be honored against the upstream API without
//! re-vendoring the diffusion sampler. We ship the foundation — public Rust
//! API + IPC + DB + path safety + storage + memory guard + event plumbing —
//! and return [`anyhow::Error`] `"image generation not implemented yet"`
//! from the actual `generate` call. The follow-up round will either
//! (a) gain access to a richer mistralrs API in a newer release, or
//! (b) re-vendor the Flux sampler inside this crate.
//!
//! Search marker: `TODO(flux-r2):`.

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

use mistralrs_core::MemoryUsage;

use super::{ImageGenRequest, ImageProgress};

/// Lazy-loaded pipeline handle. `None` until first `generate` succeeds in
/// constructing one. We keep it behind a `parking_lot::Mutex` (NOT tokio) so
/// the lock can be released across the await-free chunks of the generation
/// loop without dragging the runtime into the critical section. The pipeline
/// itself is an `Arc` to let the blocking generate task hold a strong ref
/// while a later `cancel` walks the cancellation map under a different lock.
pub struct ImageEngineInner {
    /// Currently-loaded pipeline, if any. Keyed by `(model_id, offload)` —
    /// switching between schnell and dev (or between offloaded and resident
    /// modes) drops and reloads. The `Arc` is cheap to clone so the
    /// generation task can drop the outer mutex while still holding a
    /// strong reference to the pipeline.
    pipeline: Mutex<Option<LoadedPipeline>>,
    /// Per-op cancellation notifiers. `image_cancel(op_id)` notifies the
    /// matching entry; the generation loop checks between sampling steps.
    cancellations: Mutex<HashMap<String, Arc<Notify>>>,
}

/// One loaded `(model, offload)` slot. The inner `Arc<()>` is a placeholder
/// for the eventual `Arc<Mutex<dyn Pipeline + Send + Sync>>` we'll cache once
/// we can drive it from this crate (see the scaffold note at module top).
struct LoadedPipeline {
    model_id: String,
    offload: bool,
    // TODO(flux-r2): replace `()` with
    // `std::sync::Arc<tokio::sync::Mutex<dyn mistralrs_core::Pipeline + Send + Sync>>`
    // once the upstream API exposes a step-level driver.
    _handle: Arc<()>,
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

    /// Drive one full generation. Streams progress + a terminal Done/Error
    /// onto `events`, and resolves to the encoded PNG bytes (caller writes
    /// them to disk atomically — keeps this function I/O-free for testing).
    ///
    /// SCAFFOLD: returns an error today; see module-top note.
    pub async fn generate(
        &self,
        req: ImageGenRequest,
        events: mpsc::Sender<ImageProgress>,
    ) -> Result<Vec<u8>> {
        // Sanity-clamp the memory guard so an oversized request can't slip
        // past — the IPC layer already calls `check_memory`, but defense in
        // depth is cheap.
        self.check_memory(&req.model, req.offload)?;

        // Emit a "loading" tick so the frontend can show a spinner during the
        // (currently no-op) pipeline-warm phase. Failures here are
        // non-terminal — the client just won't see the spinner update.
        let _ = events
            .send(ImageProgress::Loading {
                op_id: req.op_id.clone(),
                stage: "warmup".into(),
            })
            .await;

        // TODO(flux-r2): wire mistralrs `DiffusionLoaderBuilder::new(Some(model))
        //  .build(DiffusionLoaderType::Flux | FluxOffloaded)
        //  .load_model_from_hf(...)` once we can drive the resulting pipeline
        //  step-by-step from this crate. The current 0.8.1 public surface
        //  only exposes `RequestMessage::ImageGeneration` through the
        //  scheduler, with no progress / cancel hooks.
        let _ = &self.inner.pipeline; // touch field to silence dead-code lint
        Err(anyhow!(
            "image generation not implemented yet (mistralrs 0.8.1 public API does not expose a step-level Flux driver — see image_gen::engine module note)"
        ))
    }
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
        // Subscribe BEFORE notify so we don't miss the wake. parking_lot
        // Notify only fires already-parked waiters.
        let n2 = n.clone();
        let handle = std::thread::spawn(move || {
            // Use a tokio runtime just to await the notify.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move { n2.notified().await });
        });
        // Yield briefly so the thread can park on `.notified()`.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(e.cancel("op-7"));
        handle.join().unwrap();
        e.release_cancel("op-7");
        assert!(!e.cancel("op-7"));
    }
}
