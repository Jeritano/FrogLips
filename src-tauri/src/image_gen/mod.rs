//! Native in-process Flux image generation.
//!
//! Mirrors the [`crate::native_inference`] feature-gating pattern: the real
//! engine lives in [`engine`] behind
//! `cfg(all(feature = "native-mistralrs", target_os = "macos",
//! target_arch = "aarch64"))`, and a stub fallback returns "image gen
//! unavailable on this build" everywhere else so non-mac builds stay green.
//!
//! Public surface (engine-agnostic):
//!   * [`ImageGenOpts`] — IPC-shaped knobs (steps/cfg/seed/size/offload).
//!   * [`ImageGenRequest`] — fully-resolved request the engine actually runs.
//!   * [`ImageEngine`] — opaque facade exposing `generate(...)` + `cancel(op)`.
//!   * [`ImageProgress`] event payload variants emitted via tokio mpsc.
//!   * [`new_engine`] — process-wide singleton constructor.
//!
//! The engine itself is responsible for memory-guard, atomic PNG writes, and
//! tEXt-chunk metadata embedding. See [`engine`] and [`metadata`].

use serde::{Deserialize, Serialize};

pub mod metadata;

#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub mod engine;

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
pub use engine::{new_engine, ImageEngine};

#[cfg(not(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
)))]
pub use stub::{new_engine, ImageEngine};

/// Symmetry alias mirroring `native_inference::SharedRuntime` — kept here so a
/// future `.manage(SharedEngine)` State extractor can drop in without forcing
/// every call site through the `Lazy<ImageEngine>` singleton. Currently
/// unused by IPC (which uses the `Lazy`), so flagged dead-code-allow.
#[allow(dead_code)]
pub type SharedEngine = ImageEngine;

/// One row of the `image_list` paginated response. The engine returns rows +
/// the total count under the supplied filter so the frontend can render a
/// pager without needing a second `count(*)` round-trip.
#[derive(Clone, Debug, Serialize)]
pub struct ListImagesPage {
    pub rows: Vec<ImageMeta>,
    pub total: i64,
}

/// IPC-shaped options forwarded from the frontend. All fields optional; the
/// engine fills in defaults appropriate to the resolved model + offload mode.
///
/// The struct itself is referenced only through `ImageGenOptsArg::From` in
/// `commands/image.rs`; the conversion path goes IPC → `ImageGenOptsArg` →
/// `ImageGenRequest`, so the engine-level type is constructed indirectly.
/// Marking the type allow-dead-code so the linter doesn't complain while the
/// conversion stays explicit.
#[allow(dead_code)]
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ImageGenOpts {
    /// Sampling steps. Schnell default 4, dev default 28.
    pub steps: Option<u32>,
    /// Classifier-free guidance scale. Schnell ignores, dev default 3.5.
    pub cfg: Option<f32>,
    /// Seed for deterministic reproducibility. `None` ⇒ engine picks a fresh
    /// 64-bit random seed and records it in the saved metadata.
    pub seed: Option<u64>,
    /// `"WxH"`, e.g. `"1024x1024"`. Engine clamps to the model's supported
    /// range (Flux: multiples of 16, ≤ 1536 per side).
    pub size: Option<String>,
    /// Force CPU-offloaded variant (`FluxOffloaded`) for low-VRAM Macs. When
    /// absent, the engine picks based on the available-RAM probe.
    pub offload: Option<bool>,
    /// Opt-in to keep the pipeline loaded across generate calls. Default
    /// `false` (C1 fix): mistralrs 0.8.1's diffusion pipeline holds a
    /// load-time-seeded RNG and returns nearly identical images regardless
    /// of prompt when the same pipeline runs multiple requests. Dropping the
    /// pipeline between calls costs ~30-90 s warmup but produces correct
    /// per-prompt outputs. Power users doing identical-prompt batch runs can
    /// set this to `true` to skip the warmup, knowing they'll get the same
    /// image each time.
    pub reuse_pipeline: Option<bool>,
}

/// Short-hand for the FLUX.1 variants the model selector emits. The Rust IPC
/// layer accepts both these shorthands and full HF repo ids ("org/name");
/// shorthands are canonicalized inside `commands::image::canonicalize_flux_repo`.
///
/// `SchnellFp8` / `DevFp8` map to community-quantized repos that fit on
/// 8-12 GiB Macs (`city96/FLUX.1-*-gguf`); see the canonicalization helper
/// for the exact targets.
#[allow(dead_code)] // Re-exported through the IPC surface; some variants are
// only emitted by the frontend dropdown.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ImageGenModel {
    Schnell,
    Dev,
    SchnellFp8,
    DevFp8,
}

/// Fully-resolved request the engine actually runs. The IPC layer constructs
/// one of these from an `ImageGenOpts`, fills in defaults, and hands it to
/// `ImageEngine::generate`.
#[derive(Clone, Debug)]
pub struct ImageGenRequest {
    /// Operation id — surfaced on every progress event so the frontend can
    /// match streaming updates to its UI op. Also the cancellation key.
    pub op_id: String,
    /// Owning conversation id (`None` ⇒ global / outside any conv).
    pub conv_id: Option<i64>,
    /// HF repo id (e.g. `"black-forest-labs/FLUX.1-schnell"`).
    pub model: String,
    /// User prompt — embedded verbatim into the PNG tEXt chunk and the DB row.
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg: f32,
    /// Engine resolves `None` to a fresh random seed before the loop starts so
    /// the value persisted into the PNG + DB is reproducible.
    pub seed: u64,
    /// `true` ⇒ use `DiffusionLoaderType::FluxOffloaded` (CPU offload). The
    /// memory guard sets this when available RAM is below the non-offload
    /// threshold and the caller didn't pin it explicitly.
    pub offload: bool,
    /// `true` ⇒ keep the pipeline cached after this call. `false` (default)
    /// drops it so the next generate re-loads — works around mistralrs 0.8.1
    /// deterministic-output bug. See `ImageGenOpts::reuse_pipeline`.
    pub reuse_pipeline: bool,
}

/// Streaming progress updates surfaced by the engine. The IPC layer fans these
/// out as Tauri events (`image-progress`, `image-done`, `image-error`).
///
/// `Done` and `Error` are emitted by the IPC layer (not the engine) so the
/// engine-side construction doesn't reach them — they live here so the
/// event-pump match arm in `commands/image.rs` can stay exhaustive.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)] // Done/Error are produced by the IPC layer, not the engine.
pub enum ImageProgress {
    /// Pipeline / weights are loading. May fire once per backend boot.
    Loading { op_id: String, stage: String },
    /// Sampling step finished (`step` is 1-based, `total` is `request.steps`).
    Step {
        op_id: String,
        step: u32,
        total: u32,
    },
    /// Final image written. `image_id` is the inserted DB row id.
    Done { op_id: String, image_id: i64 },
    /// Terminal error — also unblocks the IPC future with `Err(message)`.
    Error { op_id: String, message: String },
}

/// Row-shaped record returned by `image_list` / `image_get`. The `params_json`
/// field is the same blob embedded in the PNG tEXt chunk so callers don't have
/// to re-parse the file to know how it was generated.
///
/// `seed` is recorded only when the underlying engine honors caller-supplied
/// seeds; mistralrs 0.8.1's diffusion pipeline does NOT (it uses an
/// internally-managed RNG), so today this column is always `None` for native
/// generations. The field stays in the row schema for forward-compat with
/// engines that will honor it.
#[derive(Clone, Debug, Serialize)]
pub struct ImageMeta {
    pub id: i64,
    pub conv_id: Option<i64>,
    pub model: String,
    pub prompt: String,
    pub params_json: String,
    pub path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Recorded only when the underlying engine honors caller-supplied
    /// seeds; `None` otherwise.
    pub seed: Option<i64>,
    pub created_at: i64,
}

/// `~/.local-llm-app/images/{conv_id_or_global}` — the root every generated
/// PNG lands beneath. The IPC layer asks `path_safety::validate_write_dest` to
/// confirm the resolved target sits beneath this root before the engine
/// writes.
pub fn images_root() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot determine home directory".to_string())?;
    let root = home.join(".local-llm-app").join("images");
    std::fs::create_dir_all(&root).map_err(|e| format!("failed to create images root: {e}"))?;
    Ok(root)
}

/// Compute the storage path for a single generated image, creating the bucket
/// directory if needed. Bucket is the conv id (numeric folder) or
/// `"global"` for conv-less generations.
pub fn image_path(
    conv_id: Option<i64>,
    ts_ms: i128,
    seed: u64,
) -> Result<std::path::PathBuf, String> {
    let root = images_root()?;
    let bucket = match conv_id {
        Some(id) => format!("{id}"),
        None => "global".to_string(),
    };
    let dir = root.join(&bucket);
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create images bucket: {e}"))?;
    Ok(dir.join(format!("{ts_ms}-{seed}.png")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_path_uses_global_bucket_when_no_conv() {
        let p = image_path(None, 1_700_000_000_000, 42).expect("image_path");
        assert!(p.to_string_lossy().contains("/images/global/"));
        assert!(p.to_string_lossy().ends_with("1700000000000-42.png"));
    }

    #[test]
    fn image_path_uses_conv_bucket_when_present() {
        let p = image_path(Some(7), 1, 9).expect("image_path");
        assert!(p.to_string_lossy().contains("/images/7/"));
    }
}
