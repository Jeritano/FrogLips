//! IPC surface for native image generation.
//!
//! Engine lives in `crate::image_gen` behind the same feature gates as the
//! text-gen mistralrs backend. This module is the thin adapter that:
//!   * validates inputs (prompt size, model id, opts ranges, op_id shape),
//!   * resolves an `ImageGenRequest` from the IPC-shaped `ImageGenOpts`,
//!   * picks the storage path under `~/.local-llm-app/images/{bucket}/` and
//!     hands it through `path_safety::validate_write_dest`,
//!   * spawns the generation onto a Tokio task, fans progress events out as
//!     `image-progress` / `image-done` / `image-error`,
//!   * atomically writes the PNG (`.tmp` → fsync → `rename`) and inserts the
//!     accompanying row into `images` via the v10 schema.
//!
//! Today the engine returns "not implemented" — the surface here is the
//! foundation, and the actual sampler will land in a follow-up round
//! (search marker: `TODO(flux-r2):`). The IPC contract is finished even
//! though the underlying generator is a stub, so the frontend can ship its
//! image-gen UI against a real, stable command shape now.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::history;
use crate::image_gen::{
    self, image_path, ImageEngine, ImageGenOpts, ImageGenRequest, ImageMeta, ImageProgress,
};

use super::{path_safety, validate_hf_repo};

/// Hard caps so a malformed IPC call can't allocate megabytes of prompt or
/// jam the engine with an absurdly large canvas.
const MAX_PROMPT_LEN: usize = 4096;
const MIN_SIDE: u32 = 256;
const MAX_SIDE: u32 = 1536;
const SIDE_STEP: u32 = 16;
const MAX_STEPS: u32 = 100;
const MIN_STEPS: u32 = 1;
const DEFAULT_SCHNELL_STEPS: u32 = 4;
const DEFAULT_DEV_STEPS: u32 = 28;
const DEFAULT_CFG_DEV: f32 = 3.5;
const DEFAULT_CFG_SCHNELL: f32 = 0.0;

/// Process-wide engine handle — same shape as `NativeHandle` for native text
/// inference. Lazily constructed on first `image_generate` call so cold builds
/// (no image gen requested) never pay any allocation.
static ENGINE: Lazy<ImageEngine> = Lazy::new(image_gen::new_engine);

/// IPC payload — duplicated here as a thin serde alias on top of the engine
/// type. Lives in this module so the IPC schema stays grouped with the
/// command wrappers (matches the convention `commands/agent.rs` uses for its
/// request types).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ImageGenOptsArg {
    pub steps: Option<u32>,
    pub cfg: Option<f32>,
    pub seed: Option<u64>,
    pub size: Option<String>,
    pub offload: Option<bool>,
}

impl From<ImageGenOptsArg> for ImageGenOpts {
    fn from(a: ImageGenOptsArg) -> Self {
        Self {
            steps: a.steps,
            cfg: a.cfg,
            seed: a.seed,
            size: a.size,
            offload: a.offload,
        }
    }
}

/// Begin a generation. Returns the inserted image row id once the engine
/// resolves successfully; failures during generation surface as both the
/// resolved Err and an `image-error` event so a frontend that registered the
/// listener after the call doesn't miss the terminal signal.
///
/// `op_id` is a caller-provided correlation token — every emitted progress /
/// completion / error event carries it so multiple in-flight generations can
/// be disambiguated. When omitted, the IPC layer mints one (millis + tail of
/// the seed) so the frontend always has a stable handle to call
/// `image_cancel` with.
#[tauri::command]
pub async fn image_generate(
    prompt: String,
    model: String,
    opts: Option<ImageGenOptsArg>,
    conv_id: Option<i64>,
    op_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<i64, String> {
    let request = build_request(prompt, model, opts.unwrap_or_default(), conv_id, op_id)?;
    let op_id = request.op_id.clone();

    // Engine plumbing — we hand the engine a sender, fan results out as
    // Tauri events on the corresponding receiver.
    let (tx, mut rx) = mpsc::channel::<ImageProgress>(64);
    let app_for_events = app.clone();
    let op_for_events = op_id.clone();
    let event_pump = tokio::spawn(async move {
        while let Some(evt) = rx.recv().await {
            // Route the variant onto the matching Tauri event name. The
            // payload shape mirrors the spec: `image-progress` carries
            // `{ op_id, step, total }`, `image-done` carries
            // `{ op_id, image_id }`, `image-error` carries
            // `{ op_id, message }`.
            match evt {
                ImageProgress::Loading { op_id, stage } => {
                    let _ = app_for_events.emit(
                        "image-progress",
                        serde_json::json!({
                            "op_id": op_id,
                            "stage": stage,
                            "step": 0,
                            "total": 0,
                        }),
                    );
                }
                ImageProgress::Step { op_id, step, total } => {
                    let _ = app_for_events.emit(
                        "image-progress",
                        serde_json::json!({
                            "op_id": op_id,
                            "step": step,
                            "total": total,
                        }),
                    );
                }
                ImageProgress::Done { op_id, image_id } => {
                    let _ = app_for_events.emit(
                        "image-done",
                        serde_json::json!({
                            "op_id": op_id,
                            "image_id": image_id,
                        }),
                    );
                }
                ImageProgress::Error { op_id, message } => {
                    let _ = app_for_events.emit(
                        "image-error",
                        serde_json::json!({
                            "op_id": op_id,
                            "message": message,
                        }),
                    );
                }
            }
        }
        // Best-effort drain; `_ = op_for_events` keeps the closure compact
        // when the engine is the no-op stub (no events ever fire).
        drop(op_for_events);
    });

    // Run the engine to completion; convert any panic / engine error into
    // an `image-error` event AND the `Err(_)` returned to the IPC caller so
    // both paths see the failure.
    let engine = ENGINE.clone();
    let req_for_engine = request.clone();
    let result = engine.generate(req_for_engine, tx).await;
    // Allow the pump to drain remaining events, then stop it.
    let _ = event_pump.await;

    let png_bytes = match result {
        Ok(bytes) => bytes,
        Err(e) => {
            let message = e.to_string();
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": message }),
            );
            ENGINE.release_cancel(&op_id);
            return Err(message);
        }
    };

    // Resolve the storage path and validate it sits beneath
    // `~/.local-llm-app/images/`. `validate_write_dest` canonicalizes the
    // parent so a tampered $HOME or a symlinked images/ dir can't divert the
    // write into a protected location.
    let ts_ms = ms_since_epoch();
    let path = image_path(request.conv_id, ts_ms, request.seed).inspect_err(|e| {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
    })?;
    let validated = path_safety::validate_write_dest(&path.to_string_lossy()).inspect_err(|e| {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
    })?;
    assert_under_images_root(&validated).inspect_err(|e| {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
    })?;

    // Atomic write: .tmp → fsync → rename.
    write_atomic(&validated, &png_bytes).inspect_err(|e| {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
    })?;

    // params_json mirrors the same shape embedded in the PNG.
    let params_json = format!(
        "{{\"width\":{},\"height\":{},\"steps\":{},\"cfg\":{},\"seed\":{},\"offload\":{}}}",
        request.width, request.height, request.steps, request.cfg, request.seed, request.offload,
    );

    let image_id = history::insert_image(
        request.conv_id,
        &request.model,
        &request.prompt,
        &params_json,
        &validated.to_string_lossy(),
        Some(request.width as i64),
        Some(request.height as i64),
        Some(request.seed as i64),
    )
    .map_err(|e| e.to_string())?;

    ENGINE.release_cancel(&op_id);
    let _ = app.emit(
        "image-done",
        serde_json::json!({ "op_id": op_id, "image_id": image_id }),
    );

    Ok(image_id)
}

/// List generated images, newest first. `conv_id` filters to a single
/// conversation; `None` returns all.
#[tauri::command]
pub async fn image_list(
    conv_id: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<ImageMeta>, String> {
    let rows = super::blocking(move || history::list_images(conv_id, limit)).await?;
    Ok(rows.into_iter().map(row_to_meta).collect())
}

/// Fetch a single image row.
#[tauri::command]
pub async fn image_get(id: i64) -> Result<Option<ImageMeta>, String> {
    let row = super::blocking(move || history::get_image(id)).await?;
    Ok(row.map(row_to_meta))
}

/// Delete an image — both the DB row and the on-disk PNG. The unlink is
/// gated by `path_safety::validate_write_dest` so a corrupted row whose
/// `path` was tampered with can't be used to unlink a file outside the
/// images root.
#[tauri::command]
pub async fn image_delete(id: i64) -> Result<(), String> {
    let path = super::blocking(move || history::delete_image_row(id)).await?;
    if let Some(path) = path {
        // Validate the stored path before unlinking. The validator rejects
        // anything outside the safe set; we further require the resolved
        // path to sit beneath the images root.
        let validated = path_safety::validate_write_dest(&path)?;
        assert_under_images_root(&validated)?;
        match std::fs::remove_file(&validated) {
            Ok(()) => Ok(()),
            // A missing file is fine — the row was the canonical record.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to delete image file: {e}")),
        }
    } else {
        Err(format!("image id {id} not found"))
    }
}

/// Cancel an in-flight generation. Returns `Ok(())` whether or not the op
/// was actually pending — a no-op cancel is not an error.
#[tauri::command]
pub async fn image_cancel(op_id: String) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 128 {
        return Err("op_id length out of range".into());
    }
    ENGINE.cancel(&op_id);
    Ok(())
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

fn ms_since_epoch() -> i128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0)
}

fn row_to_meta(r: history::ImageRow) -> ImageMeta {
    ImageMeta {
        id: r.id,
        conv_id: r.conv_id,
        model: r.model,
        prompt: r.prompt,
        params_json: r.params_json,
        path: r.path,
        width: r.width,
        height: r.height,
        seed: r.seed,
        created_at: r.created_at,
    }
}

fn build_request(
    prompt: String,
    model: String,
    opts: ImageGenOptsArg,
    conv_id: Option<i64>,
    op_id: Option<String>,
) -> Result<ImageGenRequest, String> {
    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".into());
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(format!("prompt exceeds {MAX_PROMPT_LEN} bytes"));
    }
    validate_hf_repo(&model)?;

    let (width, height) = parse_size(opts.size.as_deref())?;
    let is_dev = model.to_ascii_lowercase().contains("dev");
    let steps = opts
        .steps
        .unwrap_or(if is_dev {
            DEFAULT_DEV_STEPS
        } else {
            DEFAULT_SCHNELL_STEPS
        })
        .clamp(MIN_STEPS, MAX_STEPS);
    let cfg = opts.cfg.unwrap_or(if is_dev {
        DEFAULT_CFG_DEV
    } else {
        DEFAULT_CFG_SCHNELL
    });
    if !cfg.is_finite() || !(0.0..=20.0).contains(&cfg) {
        return Err("cfg out of range".into());
    }
    let seed = opts.seed.unwrap_or_else(random_seed);
    let offload = opts.offload.unwrap_or(false);

    let op_id = op_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("img-{}-{}", ms_since_epoch(), seed & 0xFFFF));
    if op_id.len() > 128 {
        return Err("op_id length out of range".into());
    }

    // Dev requires explicit opt-in to avoid blowing past the 28 GiB threshold
    // by accident. The frontend can prompt the user; we keep the policy here
    // so the rule survives a malicious renderer.
    if is_dev && !offload && opts.offload.is_none() {
        // Allow the call through — `engine::check_memory` is the
        // authoritative guard. We just refuse to *implicitly* pick the
        // non-offloaded dev pipeline without explicit caller choice.
        return Err(
            "Flux.dev requires offload=true|false to be set explicitly (28 GiB resident)".into(),
        );
    }

    Ok(ImageGenRequest {
        op_id,
        conv_id,
        model,
        prompt,
        width,
        height,
        steps,
        cfg,
        seed,
        offload,
    })
}

fn parse_size(s: Option<&str>) -> Result<(u32, u32), String> {
    let raw = s.unwrap_or("1024x1024");
    let (w, h) = raw
        .split_once('x')
        .ok_or_else(|| "size must be WxH (e.g. 1024x1024)".to_string())?;
    let w: u32 = w.parse().map_err(|_| "size width is not an integer")?;
    let h: u32 = h.parse().map_err(|_| "size height is not an integer")?;
    if !(MIN_SIDE..=MAX_SIDE).contains(&w) || !(MIN_SIDE..=MAX_SIDE).contains(&h) {
        return Err(format!(
            "size sides must be in {}-{} (got {}x{})",
            MIN_SIDE, MAX_SIDE, w, h
        ));
    }
    if !w.is_multiple_of(SIDE_STEP) || !h.is_multiple_of(SIDE_STEP) {
        return Err(format!("size sides must be a multiple of {SIDE_STEP}"));
    }
    Ok((w, h))
}

fn random_seed() -> u64 {
    // No need for a CSPRNG here — this is image-generation determinism, not a
    // crypto key. Mixing nanos with the process id is enough to avoid
    // accidental collisions across concurrent calls in the same millisecond.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

/// Hard-fence: the resolved write target must sit beneath
/// `~/.local-llm-app/images/`. `path_safety::validate_write_dest` already
/// catches denylisted system dirs and `..` traversal; this second check
/// pins the scope to the images root so an attacker who somehow bypassed
/// the first one still can't write to an arbitrary user file.
fn assert_under_images_root(path: &std::path::Path) -> Result<(), String> {
    let root = image_gen::images_root()?;
    let canon_root =
        std::fs::canonicalize(&root).map_err(|e| format!("images root not accessible: {e}"))?;
    if !path.starts_with(&canon_root) {
        return Err(format!(
            "path {} escapes images root {}",
            path.display(),
            canon_root.display()
        ));
    }
    Ok(())
}

/// Atomic write — `.tmp` next to the destination, fsync, then `rename` over
/// the final path. Same shape as `agent/fs.rs::write_nofollow_sync`, but the
/// final rename gives us crash-safety: a partially-written `.tmp` is never
/// observable as a real image row because the row only lands AFTER the
/// rename succeeds.
fn write_atomic(dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = dest
        .parent()
        .ok_or_else(|| "destination has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("failed to create image parent: {e}"))?;
    let mut tmp = PathBuf::from(dest);
    let new_name = format!(
        "{}.tmp",
        dest.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.png")
    );
    tmp.set_file_name(new_name);
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("failed to open temp file: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("failed to write image bytes: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("failed to fsync image: {e}"))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        // Best-effort cleanup — leave the tmp file around if the rename
        // failed and we can't remove it either; surfacing the rename error
        // is more informative than masking it with the cleanup error.
        let _ = std::fs::remove_file(&tmp);
        format!("failed to finalize image: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_size_accepts_square() {
        assert_eq!(parse_size(Some("1024x1024")).unwrap(), (1024, 1024));
        assert_eq!(parse_size(None).unwrap(), (1024, 1024));
    }

    #[test]
    fn parse_size_rejects_misshaped_and_out_of_range() {
        assert!(parse_size(Some("1024")).is_err());
        assert!(parse_size(Some("100x100")).is_err()); // below MIN_SIDE
        assert!(parse_size(Some("2048x2048")).is_err()); // above MAX_SIDE
        assert!(parse_size(Some("1023x1024")).is_err()); // not multiple of 16
    }

    #[test]
    fn build_request_rejects_empty_prompt() {
        let r = build_request(
            "   ".into(),
            "black-forest-labs/FLUX.1-schnell".into(),
            Default::default(),
            None,
            None,
        );
        assert!(r.is_err());
    }

    #[test]
    fn build_request_picks_schnell_defaults() {
        let r = build_request(
            "a cat".into(),
            "black-forest-labs/FLUX.1-schnell".into(),
            Default::default(),
            Some(7),
            Some("op-1".into()),
        )
        .unwrap();
        assert_eq!(r.steps, DEFAULT_SCHNELL_STEPS);
        assert_eq!(r.cfg, DEFAULT_CFG_SCHNELL);
        assert_eq!(r.width, 1024);
        assert_eq!(r.height, 1024);
        assert_eq!(r.conv_id, Some(7));
        assert_eq!(r.op_id, "op-1");
        assert!(!r.offload);
    }

    #[test]
    fn build_request_requires_explicit_offload_for_dev() {
        let r = build_request(
            "a cat".into(),
            "black-forest-labs/FLUX.1-dev".into(),
            Default::default(),
            None,
            None,
        );
        assert!(r.is_err(), "dev without explicit offload must be rejected");

        let r = build_request(
            "a cat".into(),
            "black-forest-labs/FLUX.1-dev".into(),
            ImageGenOptsArg {
                offload: Some(true),
                ..Default::default()
            },
            None,
            None,
        )
        .expect("dev with explicit offload");
        assert!(r.offload);
        assert_eq!(r.steps, DEFAULT_DEV_STEPS);
    }

    #[test]
    fn assert_under_images_root_rejects_traversal() {
        // Build a fake path outside the images root — it must be rejected.
        let outside = std::env::temp_dir().join("not-an-image.png");
        let result = assert_under_images_root(&outside);
        assert!(result.is_err(), "outside-root path must be rejected");
    }
}
