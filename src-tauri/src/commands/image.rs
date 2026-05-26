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
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::history;
use crate::image_gen::{
    self, image_path, ImageEngine, ImageGenOpts, ImageGenRequest, ImageMeta, ImageProgress,
    ListImagesPage,
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
    pub reuse_pipeline: Option<bool>,
}

impl From<ImageGenOptsArg> for ImageGenOpts {
    fn from(a: ImageGenOptsArg) -> Self {
        Self {
            steps: a.steps,
            cfg: a.cfg,
            seed: a.seed,
            size: a.size,
            offload: a.offload,
            reuse_pipeline: a.reuse_pipeline,
        }
    }
}

/// Begin a generation. Returns the **op_id** IMMEDIATELY — the actual
/// diffusion runs on a background task and surfaces results via Tauri events
/// (`image-progress` / `image-done` / `image-error`), all carrying the
/// returned op_id.
///
/// IMPORTANT (H3): the frontend MUST register `listen("image-progress")`,
/// `listen("image-done")`, and `listen("image-error")` BEFORE calling
/// `image_generate`. The engine waits ~50 ms before its first event emit to
/// give the listener time to attach, but a frontend that races the call may
/// still miss the warmup event. The returned op_id correlates every event
/// back to the originating call.
///
/// `op_id` is an optional caller-provided correlation token; when omitted,
/// the IPC layer mints one (millis + tail of the seed) so the frontend
/// always has a stable handle to call `image_cancel` with.
#[tauri::command]
pub async fn image_generate(
    prompt: String,
    model: String,
    opts: Option<ImageGenOptsArg>,
    conv_id: Option<i64>,
    op_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let request = build_request(prompt, model, opts.unwrap_or_default(), conv_id, op_id)?;
    let op_id = request.op_id.clone();

    // Register the cancel token UP FRONT so an `image_cancel(op_id)` call
    // that arrives before the engine has lazy-registered finds the entry.
    let _ = ENGINE.register_cancel(&op_id);

    // Spawn the work on a Tokio task and return the op_id immediately. All
    // progress/result delivery flows through Tauri events from here.
    let app_for_task = app.clone();
    let op_for_task = op_id.clone();
    let request_for_task = request.clone();
    tokio::spawn(async move {
        run_generation(app_for_task, request_for_task, op_for_task).await;
    });

    Ok(op_id)
}

/// Background-task body for one generation. Owns the engine call, the event
/// pump, the atomic write, and the DB insert. Emits exactly one terminal
/// event (`image-done` or `image-error`) per op_id. Never panics — any error
/// is surfaced via `image-error`.
async fn run_generation(app: tauri::AppHandle, request: ImageGenRequest, op_id: String) {
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
        drop(op_for_events);
    });

    // Run the engine to completion; convert any panic / engine error into
    // an `image-error` event.
    let engine = ENGINE.clone();
    let req_for_engine = request.clone();
    let result = engine.generate(req_for_engine, tx).await;
    let _ = event_pump.await;

    let png_bytes_raw = match result {
        Ok(bytes) => bytes,
        Err(e) => {
            let mut message = format!("{e:#}");
            if let Some(hint) = hf_load_hint(&message) {
                message.push_str("\n\nHint: ");
                message.push_str(hint);
            }
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": message }),
            );
            ENGINE.release_cancel(&op_id);
            return;
        }
    };

    // C2: round-trip the PNG through `metadata::encode_with_metadata` so
    // the `prompt`, `model`, `params_json`, `version` ZTXt chunks are
    // actually present on disk.
    let params_json = build_params_json(&request);
    let png_bytes = match reencode_with_metadata(&png_bytes_raw, &request, &params_json) {
        Ok(b) => b,
        Err(e) => {
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": e }),
            );
            ENGINE.release_cancel(&op_id);
            return;
        }
    };

    // Resolve the storage path and validate it sits beneath
    // `~/.local-llm-app/images/`.
    let ts_ms = ms_since_epoch();
    let path = match image_path(request.conv_id, ts_ms, request.seed) {
        Ok(p) => p,
        Err(e) => {
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": e }),
            );
            ENGINE.release_cancel(&op_id);
            return;
        }
    };
    let validated = match path_safety::validate_write_dest(&path.to_string_lossy()) {
        Ok(p) => p,
        Err(e) => {
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": e }),
            );
            ENGINE.release_cancel(&op_id);
            return;
        }
    };
    if let Err(e) = assert_under_images_root(&validated) {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
        ENGINE.release_cancel(&op_id);
        return;
    }

    // Atomic write: .tmp → fsync file → rename → fsync parent (M7).
    if let Err(e) = write_atomic(&validated, &png_bytes) {
        let _ = app.emit(
            "image-error",
            serde_json::json!({ "op_id": op_id, "message": e }),
        );
        ENGINE.release_cancel(&op_id);
        return;
    }

    // M1: seed is engine-fabricated today. mistralrs 0.8.1's diffusion
    // pipeline uses an internally-managed RNG; the seed in `request` is the
    // value our IPC picked but the engine never consumed it. Record `None`
    // in the DB column so the frontend can honestly say "seed not honored
    // by current engine".
    let seed_column: Option<i64> = None;
    let image_id = match history::insert_image(
        request.conv_id,
        &request.model,
        &request.prompt,
        &params_json,
        &validated.to_string_lossy(),
        Some(request.width as i64),
        Some(request.height as i64),
        seed_column,
    ) {
        Ok(id) => id,
        Err(e) => {
            let _ = app.emit(
                "image-error",
                serde_json::json!({ "op_id": op_id, "message": e.to_string() }),
            );
            ENGINE.release_cancel(&op_id);
            return;
        }
    };

    ENGINE.release_cancel(&op_id);
    let _ = app.emit(
        "image-done",
        serde_json::json!({ "op_id": op_id, "image_id": image_id }),
    );
}

/// List generated images, newest first, with pagination. `conv_id` filters
/// to a single conversation; `None` returns all. `limit` is capped at
/// [`history::IMAGES_PAGE_LIMIT_MAX`] (200); `offset` is honored verbatim.
/// Returns `{ rows, total }` where `total` is the unpaginated count under
/// the same filter so the frontend can render a pager without a second
/// round-trip.
#[tauri::command]
pub async fn image_list(
    conv_id: Option<i64>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<ListImagesPage, String> {
    let (rows, total) =
        super::blocking(move || history::list_images_page(conv_id, limit, offset)).await?;
    Ok(ListImagesPage {
        rows: rows.into_iter().map(row_to_meta).collect(),
        total,
    })
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
///
/// Reliability: pre-dispatch cancels (before the engine sends the request to
/// mistralrs) ARE reliable now (C3 fix — backed by
/// `tokio_util::sync::CancellationToken`). Mid-diffusion cancel remains
/// best-effort against mistralrs 0.8.1 — the engine still drops its
/// response receiver and stops emitting events for the op, but the
/// underlying diffusion work continues to completion.
#[tauri::command]
pub async fn image_cancel(op_id: String) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 128 {
        return Err("op_id length out of range".into());
    }
    ENGINE.cancel(&op_id);
    Ok(())
}

/// Unload the currently-resident pipeline (~14-28 GiB) so the OS can reclaim
/// the memory. Idempotent — calling when nothing is loaded is a no-op.
/// Returns `true` when a slot was actually dropped, `false` otherwise so
/// the frontend can disambiguate "freed memory" from "already idle".
#[tauri::command]
pub async fn image_unload() -> Result<bool, String> {
    Ok(ENGINE.unload())
}

/// Copy a previously-generated PNG (by row id) to a user-chosen destination.
/// `dest` is validated through `path_safety::validate_write_dest` so the
/// privileged backend can't be tricked into writing into `~/.ssh/`, the
/// keychain, `/etc`, etc. Returns the resolved canonical destination path
/// so the frontend can show a "Saved to X" toast.
///
/// The copy itself is atomic: write to `<dest>.tmp`, fsync, rename, fsync
/// parent. A power-loss mid-copy leaves `<dest>` either fully written or
/// not present.
#[tauri::command]
pub async fn image_save_to(id: i64, dest: String) -> Result<String, String> {
    if id < 0 {
        return Err("id must be non-negative".into());
    }
    let validated_dest = path_safety::validate_write_dest(&dest)?;
    // Sec review M6: require .png suffix so the model can't use this IPC to
    // drop arbitrary-named bytes anywhere the user has approved. The image
    // bytes are still PNG-encoded; the suffix check prevents a model from
    // (for example) naming the output `~/Library/LaunchAgents/foo.plist`
    // and relying on macOS handling rules.
    match validated_dest
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        Some(ext) if ext == "png" => {}
        _ => {
            return Err("destination must have a .png extension".into());
        }
    }
    let validated_dest_str = validated_dest.to_string_lossy().to_string();

    // Resolve the source row + validate the on-disk path before we copy.
    let row = super::blocking(move || history::get_image(id))
        .await?
        .ok_or_else(|| format!("image id {id} not found"))?;
    let src_validated = path_safety::validate_read_src(&row.path)?;
    let src_path = src_validated.to_string_lossy().to_string();

    let dest_for_blocking = validated_dest.clone();
    super::blocking(move || {
        let bytes = std::fs::read(&src_path)
            .map_err(|e| anyhow::anyhow!("failed to read source image: {e}"))?;
        write_atomic(&dest_for_blocking, &bytes).map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(())
    })
    .await?;

    Ok(validated_dest_str)
}

/// Open a previously-generated PNG in the user's default macOS image viewer
/// (Preview by default). Shells to `/usr/bin/open <path>` after validating
/// the row exists and the on-disk path sits beneath the images root.
///
/// Why a separate IPC: WebKit's right-click "Open image in new window" fails
/// on `asset://` URLs because Tauri 2 blocks new-window creation by default
/// and the asset scheme is not a real http URL the OS can route to. This
/// gives the frontend a working "Open in Preview" affordance.
#[tauri::command]
pub async fn image_open_external(id: i64) -> Result<(), String> {
    if id < 0 {
        return Err("id must be non-negative".into());
    }
    let row = super::blocking(move || history::get_image(id))
        .await?
        .ok_or_else(|| format!("image id {id} not found"))?;
    let src = path_safety::validate_read_src(&row.path)?;
    assert_under_images_root(&src)?;
    let path_str = src.to_string_lossy().to_string();
    super::blocking(move || {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&path_str)
            .status()
            .map_err(|e| anyhow::anyhow!("failed to spawn /usr/bin/open: {e}"))?;
        if !status.success() {
            return Err(anyhow::anyhow!("/usr/bin/open exited with status {status}"));
        }
        Ok(())
    })
    .await
}

/// Reveal a previously-generated PNG in Finder (selects the file). Shells to
/// `/usr/bin/open -R <path>` after the same validation as
/// `image_open_external`. WebKit has no equivalent context-menu action.
#[tauri::command]
pub async fn image_reveal_in_finder(id: i64) -> Result<(), String> {
    if id < 0 {
        return Err("id must be non-negative".into());
    }
    let row = super::blocking(move || history::get_image(id))
        .await?
        .ok_or_else(|| format!("image id {id} not found"))?;
    let src = path_safety::validate_read_src(&row.path)?;
    assert_under_images_root(&src)?;
    let path_str = src.to_string_lossy().to_string();
    super::blocking(move || {
        let status = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&path_str)
            .status()
            .map_err(|e| anyhow::anyhow!("failed to spawn /usr/bin/open -R: {e}"))?;
        if !status.success() {
            return Err(anyhow::anyhow!(
                "/usr/bin/open -R exited with status {status}"
            ));
        }
        Ok(())
    })
    .await
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
    // Canonicalize the model shorthand the UI sends ("schnell" / "dev")
    // into the full HF repo id before validation. The frontend's model
    // dropdown surfaces friendly labels; the engine wants the org/name
    // form mistralrs's FluxLoader hands to hf_hub.
    let model = canonicalize_flux_repo(&model);
    validate_hf_repo(&model)?;

    let (width, height) = parse_size(opts.size.as_deref())?;
    // L1: exact-match check against canonical FLUX.1-dev repo ids. The old
    // `contains("dev")` substring check would false-positive on names like
    // `developer-edition` or `lewdev`.
    let is_dev = is_dev_model(&model);
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
    let reuse_pipeline = opts.reuse_pipeline.unwrap_or(false);

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
        reuse_pipeline,
    })
}

/// Whether `model` (already canonicalized to a HF repo id) is a FLUX.1-dev
/// variant. Delegates to the engine when the real backend is compiled in so
/// the stub build doesn't have to mirror the list; on stub builds falls back
/// to a hard-coded set.
#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn is_dev_model(model: &str) -> bool {
    crate::image_gen::engine::is_dev_repo(model)
}

#[cfg(not(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
)))]
fn is_dev_model(model: &str) -> bool {
    matches!(model.trim(), "black-forest-labs/FLUX.1-dev")
}

/// Build the deterministic params JSON blob mirrored between the PNG ZTXt
/// chunk and the DB row. Field order is fixed so the encoded bytes don't
/// churn between identical generations.
fn build_params_json(request: &ImageGenRequest) -> String {
    format!(
        "{{\"width\":{},\"height\":{},\"steps\":{},\"cfg\":{},\"seed\":{},\"offload\":{},\"reuse_pipeline\":{}}}",
        request.width,
        request.height,
        request.steps,
        request.cfg,
        request.seed,
        request.offload,
        request.reuse_pipeline,
    )
}

/// C2: re-encode the raw PNG bytes the engine returns through
/// `metadata::encode_with_metadata` so the resulting file carries `prompt`,
/// `model`, `params_json`, `version` ZTXt chunks. Decodes the engine PNG via
/// the `png` crate (already a dependency under `native-mistralrs`), extracts
/// the raw pixel buffer, then re-encodes through the metadata helper.
///
/// Round-trip cost on a 1024² image is small (~50 ms) and bounded — if the
/// engine ever ships a build that already embeds chunks, the round-trip
/// strips them and re-embeds with the canonical shape, which is the
/// behaviour we want (single source of truth).
#[cfg(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn reencode_with_metadata(
    raw_png: &[u8],
    request: &ImageGenRequest,
    params_json: &str,
) -> Result<Vec<u8>, String> {
    use crate::image_gen::metadata::{encode_with_metadata, PngMetadata};

    let decoder = png::Decoder::new(std::io::Cursor::new(raw_png));
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("failed to decode engine PNG header: {e}"))?;
    let info = reader.info().clone();
    if info.color_type != png::ColorType::Rgb || info.bit_depth != png::BitDepth::Eight {
        // The metadata helper currently only handles RGB8 — if the engine
        // ever returns something else we'd rather write the raw bytes than
        // mis-decode + corrupt the image. Document the gap and pass through.
        return Ok(raw_png.to_vec());
    }
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("failed to decode engine PNG idat: {e}"))?;
    buf.truncate(frame.buffer_size());

    let meta = PngMetadata {
        prompt: &request.prompt,
        model: &request.model,
        width: info.width,
        height: info.height,
        steps: request.steps,
        cfg: request.cfg,
        seed: request.seed,
        offload: request.offload,
        reuse_pipeline: request.reuse_pipeline,
    };
    // The chunk content built inside the encoder must agree with the DB
    // column we're about to insert — `PngMetadata::params_json()` and
    // `build_params_json(request)` produce the same string by construction.
    debug_assert_eq!(meta.params_json(), params_json);
    encode_with_metadata(&buf, info.width, info.height, &meta)
}

#[cfg(not(all(
    feature = "native-mistralrs",
    target_os = "macos",
    target_arch = "aarch64"
)))]
fn reencode_with_metadata(
    raw_png: &[u8],
    _request: &ImageGenRequest,
    _params_json: &str,
) -> Result<Vec<u8>, String> {
    Ok(raw_png.to_vec())
}

/// Surface an actionable hint from a HuggingFace load failure. Most common
/// gotcha is a gated repo (FLUX.1-dev requires a license-accept token) — the
/// raw "401 Unauthorized" / "403 Forbidden" / "Repository not found" strings
/// are useless to a non-engineer; tell them what to do instead.
fn hf_load_hint(message: &str) -> Option<&'static str> {
    let m = message.to_ascii_lowercase();
    if m.contains("401")
        || m.contains("403")
        || m.contains("unauthorized")
        || m.contains("forbidden")
        || m.contains("gated")
        || m.contains("access to model")
    {
        return Some(
            "FLUX.1-dev is a gated repo on HuggingFace. Either accept the license on \
             https://huggingface.co/black-forest-labs/FLUX.1-dev and run \
             `huggingface-cli login` (Apache-2.0 alternative: pick FLUX.1-schnell — \
             same dropdown), or stick to schnell which has no gate.",
        );
    }
    if m.contains("repository not found") || m.contains("not found") || m.contains("could not find")
    {
        return Some(
            "HuggingFace says that repo id doesn't exist. Double-check the model selector — \
             only black-forest-labs/FLUX.1-{schnell,dev} are wired in today.",
        );
    }
    if m.contains("network")
        || m.contains("dns")
        || m.contains("connection")
        || m.contains("timed out")
    {
        return Some(
            "Could not reach huggingface.co. Check your network; the HF API needs to be \
             reachable on first model load (cached afterwards).",
        );
    }
    if m.contains("no space") || m.contains("disk") {
        return Some(
            "Out of disk space — FLUX.1-schnell needs ~14 GiB free under \
             ~/.cache/huggingface/, dev needs ~28 GiB.",
        );
    }
    None
}

/// Map the UI's friendly Flux model shorthand to the canonical HuggingFace
/// repo id. Anything already in `org/name` form passes through untouched so
/// power users can point at a community fork.
///
/// F1 (quantized variants) reverted: mistralrs 0.8.1's `FluxLoader` requires
/// the BFL multi-file safetensors layout (separate `transformer/`,
/// `text_encoder/`, `text_encoder_2/`, `vae/` directories). Community
/// GGUF / single-file fp8 repos (`city96/FLUX.1-*-gguf`, `Kijai/flux-fp8`)
/// only ship the transformer weights and fail with `"Expected at least 1
/// .safetensors file matching the FLUX regex"`. Upstream has no GGUF Flux
/// loader yet — restoring the variants needs either a richer mistralrs
/// release or our own vendored loader. Until then we only expose the two
/// repos that actually load.
fn canonicalize_flux_repo(model: &str) -> String {
    let trimmed = model.trim();
    match trimmed {
        // Exact shorthand the frontend dropdown emits.
        "schnell" | "FLUX.1-schnell" | "flux-schnell" | "flux.1-schnell" => {
            "black-forest-labs/FLUX.1-schnell".to_string()
        }
        "dev" | "FLUX.1-dev" | "flux-dev" | "flux.1-dev" => {
            "black-forest-labs/FLUX.1-dev".to_string()
        }
        // Already canonical (or a custom repo) — pass through.
        other => other.to_string(),
    }
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
///
/// M6: the canonical images root is cached after the first successful
/// resolution. The directory is created once at module init and never
/// moved — re-canonicalizing on every write was wasteful.
fn assert_under_images_root(path: &std::path::Path) -> Result<(), String> {
    let canon_root = canonical_images_root()?;
    if !path.starts_with(canon_root) {
        return Err(format!(
            "path {} escapes images root {}",
            path.display(),
            canon_root.display()
        ));
    }
    Ok(())
}

/// Cached canonical `~/.local-llm-app/images/` path. The lookup runs once per
/// process; subsequent calls return the cached `PathBuf` slice.
static CANON_IMAGES_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn canonical_images_root() -> Result<&'static std::path::Path, String> {
    if let Some(p) = CANON_IMAGES_ROOT.get() {
        return Ok(p.as_path());
    }
    let root = image_gen::images_root()?;
    let canon =
        std::fs::canonicalize(&root).map_err(|e| format!("images root not accessible: {e}"))?;
    // Race: two concurrent callers may both compute the canonical path; the
    // first wins, the second's result is dropped. Either way the stored
    // value is correct.
    let _ = CANON_IMAGES_ROOT.set(canon);
    Ok(CANON_IMAGES_ROOT.get().expect("just set").as_path())
}

/// Hard cap on the gallery. Once total bytes inside images_root() exceed
/// this, oldest-first eviction runs until the new write fits. 2 GiB is
/// roughly 2k FLUX.1-schnell 1024x1024 PNGs (~1 MB each) — generous for
/// a personal scratch gallery but bounded so a runaway loop or hostile
/// agent can't fill the disk silently. Configurable via a future setting.
const GALLERY_BYTES_CAP: u64 = 2 * 1024 * 1024 * 1024;

/// Gallery-wide write lock. Held for the eviction + write_atomic
/// rename sequence so concurrent image generations can't race the
/// inventory (one thread reading file sizes while another renames a
/// `.tmp` into place would compute a stale total) or race the eviction
/// itself (one thread's eviction deleting the destination another
/// thread is about to rename onto). std::sync::Mutex is fine here
/// because the critical section is fast (filesystem syscalls, no
/// awaits); the IPC layer already serializes per-image at the agent
/// loop, so contention is rare even under bursts.
static GALLERY_WRITE_LOCK: Lazy<std::sync::Mutex<()>> =
    Lazy::new(|| std::sync::Mutex::new(()));

/// Inventory entry: (path, size in bytes, modified time). Type alias
/// extracted to silence `clippy::type_complexity` on the rust-1.95 CI
/// gate which trips on the 3-element tuple inside the Vec inside the
/// Result.
type GalleryEntry = (PathBuf, u64, SystemTime);

/// Walk `root` recursively summing regular-file sizes. Symlinks are NOT
/// followed (defense against a symlink pointing outside the gallery
/// skewing the budget). Returns (total_bytes, files_sorted_by_mtime_asc).
fn gallery_inventory(root: &std::path::Path) -> Result<(u64, Vec<GalleryEntry>), String> {
    let mut total: u64 = 0;
    let mut files: Vec<GalleryEntry> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let p = entry.path();
            let md = match std::fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                stack.push(p);
            } else if md.is_file() {
                let sz = md.len();
                let mtime = md.modified().unwrap_or(UNIX_EPOCH);
                total += sz;
                files.push((p, sz, mtime));
            }
        }
    }
    files.sort_by_key(|(_, _, m)| *m);
    Ok((total, files))
}

/// Evict oldest files from the gallery until total bytes + `incoming_bytes`
/// fits under `GALLERY_BYTES_CAP`. Best-effort: deletion failures are
/// logged via diagnostics and skipped. Returns the count of files evicted.
fn evict_until_under_cap(incoming_bytes: u64) -> Result<usize, String> {
    let root = canonical_images_root()?;
    let (mut total, files) = gallery_inventory(root)?;
    if total + incoming_bytes <= GALLERY_BYTES_CAP {
        return Ok(0);
    }
    let mut evicted = 0usize;
    for (path, size, _mtime) in files {
        if total + incoming_bytes <= GALLERY_BYTES_CAP {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(_) => {
                total = total.saturating_sub(size);
                evicted += 1;
            }
            Err(e) => {
                crate::diagnostics::warn_with(
                    "image-gallery",
                    "eviction failed",
                    serde_json::json!({ "path": path.display().to_string(), "error": e.to_string() }),
                );
            }
        }
    }
    if evicted > 0 {
        crate::diagnostics::info(
            "image-gallery",
            &format!(
                "evicted {} old image(s) to stay under {} byte cap",
                evicted, GALLERY_BYTES_CAP
            ),
        );
    }
    Ok(evicted)
}

/// Atomic write — `.tmp` next to the destination, fsync the file, `rename`
/// over the final path, fsync the parent directory. Same shape as
/// `agent/fs.rs::write_nofollow_sync`, with the parent-dir fsync added (M7)
/// so a power-loss between the rename and the next periodic OS flush
/// doesn't leave the directory entry pointing at nothing.
///
/// Before writing, runs eviction so a gallery that has filled to its
/// hard cap (GALLERY_BYTES_CAP) sheds oldest-first to make room. Without
/// this, a long-running session of image generation can balloon the
/// gallery to disk-full and crash subsequent writes mid-stream.
fn write_atomic(dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    // Serialize eviction + write under one lock so concurrent image
    // generations can't race the inventory or evict each other's
    // destination. The lock is dropped at function exit so the parent
    // IPC continues to handle multiple in-flight requests, just not
    // through the critical fs section. Poison-recovery: re-take the
    // lock data even on PoisonError — the lock data is `()`, nothing
    // to corrupt.
    let _guard = GALLERY_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Best-effort eviction. If it fails we still try to write — the
    // atomic-write below will fail with a clearer disk-full error if
    // there really is no space.
    let _ = evict_until_under_cap(bytes.len() as u64);
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
    // M7: fsync the parent dir so the rename is durable. APFS / ext4 can
    // both lose the directory entry on power loss between rename and the
    // next periodic flush. Best-effort — a fsync failure here only loses
    // crash-safety, not the data itself, so we don't error out.
    fsync_parent_best_effort(parent);
    Ok(())
}

/// Open `parent` for read and call `sync_all` so the directory entry change
/// from the preceding `rename` is durable. Best-effort: directory fsync is
/// supported on macOS HFS+/APFS and on Linux, but a closed-file-handle EBADF
/// or platform that doesn't honor it is non-fatal — the file content is
/// already on disk via the file fsync.
fn fsync_parent_best_effort(parent: &std::path::Path) {
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
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

    #[test]
    fn canonicalize_flux_repo_maps_known_shorthand() {
        assert_eq!(
            canonicalize_flux_repo("schnell"),
            "black-forest-labs/FLUX.1-schnell"
        );
        assert_eq!(
            canonicalize_flux_repo("dev"),
            "black-forest-labs/FLUX.1-dev"
        );
        // Unknown ids pass through verbatim so power users can point at
        // a custom fork without needing a new shorthand.
        assert_eq!(
            canonicalize_flux_repo("MyOrg/my-flux-fork"),
            "MyOrg/my-flux-fork"
        );
    }

    #[test]
    fn build_params_json_is_deterministic_and_contains_reuse_flag() {
        let req = ImageGenRequest {
            op_id: "op-1".into(),
            conv_id: None,
            model: "black-forest-labs/FLUX.1-schnell".into(),
            prompt: "a cat".into(),
            width: 1024,
            height: 1024,
            steps: 4,
            cfg: 0.0,
            seed: 42,
            offload: false,
            reuse_pipeline: false,
        };
        let a = build_params_json(&req);
        let b = build_params_json(&req);
        assert_eq!(a, b);
        assert!(a.contains("\"reuse_pipeline\":false"));
        assert!(a.contains("\"seed\":42"));
        assert!(a.starts_with("{\"width\":1024,"));
    }

    /// M7 verification — `write_atomic` produces a regular file at the dest
    /// path and the file content matches the input bytes. The fsync calls
    /// themselves can't be unit-tested (kernel side-effect with no observable
    /// from userspace), but the rename + write are observable here.
    #[test]
    fn write_atomic_lands_bytes_at_dest() {
        let tmp = std::env::temp_dir().join(format!("froglips-img-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let dest = tmp.join("out.png");
        let bytes = b"\x89PNG\r\n\x1a\nfake-image-bytes".to_vec();
        write_atomic(&dest, &bytes).expect("write atomic");
        assert!(dest.exists(), "destination must exist after atomic write");
        let read = std::fs::read(&dest).unwrap();
        assert_eq!(read, bytes);
        // The .tmp sibling must not linger.
        let tmp_sibling = tmp.join("out.png.tmp");
        assert!(!tmp_sibling.exists(), ".tmp must be renamed away");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// C2 round-trip test for the metadata encoder. Encode a known-good
    /// 64×64 RGB8 buffer through `encode_with_metadata`, decode the result
    /// back with the `png` crate, and assert the four ZTXt chunks are
    /// recoverable with the values we put in.
    #[cfg(all(
        feature = "native-mistralrs",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn metadata_roundtrip_recovers_ztxt_chunks() {
        use crate::image_gen::metadata::{encode_with_metadata, PngMetadata};

        let w = 64u32;
        let h = 64u32;
        let mut buf = vec![0u8; (w * h * 3) as usize];
        // Fill with a non-trivial gradient so the IDAT isn't all zeros.
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 3) as usize;
                buf[i] = (x * 4) as u8;
                buf[i + 1] = (y * 4) as u8;
                buf[i + 2] = ((x + y) * 2) as u8;
            }
        }
        let meta = PngMetadata {
            prompt: "a cat in a hat",
            model: "black-forest-labs/FLUX.1-schnell",
            width: w,
            height: h,
            steps: 4,
            cfg: 0.0,
            seed: 42,
            offload: false,
            reuse_pipeline: false,
        };
        let encoded = encode_with_metadata(&buf, w, h, &meta).expect("encode");
        let decoder = png::Decoder::new(std::io::Cursor::new(&encoded));
        let reader = decoder.read_info().expect("read header");
        let info = reader.info();
        // ZTXt chunks land in `info.compressed_latin1_text`; tEXt would be
        // in `uncompressed_latin1_text`. We wrote ZTXt above.
        let chunks: std::collections::HashMap<String, String> = info
            .compressed_latin1_text
            .iter()
            .filter_map(|c| {
                let mut c = c.clone();
                c.decompress_text().ok()?;
                Some((c.keyword.clone(), c.get_text().ok()?))
            })
            .collect();
        assert_eq!(
            chunks.get("prompt").map(String::as_str),
            Some("a cat in a hat")
        );
        assert_eq!(
            chunks.get("model").map(String::as_str),
            Some("black-forest-labs/FLUX.1-schnell")
        );
        let params = chunks.get("params_json").expect("params_json chunk");
        assert!(params.contains("\"width\":64"));
        assert!(params.contains("\"seed\":42"));
        assert!(chunks.contains_key("version"));
    }
}
