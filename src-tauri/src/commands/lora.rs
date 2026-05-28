//! IPC adapters for the LoRA pre-merge pipeline.
//!
//! Frontend contract (see `src/lib/tauri-api.ts::lora*` + the
//! `lora-merge-*` event names): every IPC arg is camelCase on the JS
//! side; Tauri converts to snake_case automatically when matching the
//! parameter names below. Event payloads are emitted as `snake_case` JSON
//! objects (`op_id`, not `opId`) per the JS subscriber's expectations.
//!
//! The actual merge work runs on a `spawn_blocking` thread — candle-core
//! matmul on multi-GiB tensors would stall a Tokio worker. The IPC layer
//! returns the success row to the calling JS promise AND emits the
//! `lora-merge-done` event with the same row, so the frontend's
//! "whichever-fires-first" wins path lands the same data either way.

use std::path::PathBuf;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::Emitter;

use crate::image_gen::lora::{
    self, LoraMergeRow, LoraMetadata, MergeProgress, ALLOWED_BASES,
};

/// `^[A-Za-z0-9_\-]+$` for op_id validation. Built once.
static OP_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_\-]+$").unwrap());

/// Hard cap on the LoRA file size we accept through `lora_inspect` /
/// `lora_merge`. 4 GiB matches the spec; bigger files are almost certainly
/// not LoRA adapters anyway.
const MAX_LORA_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Validate inputs shared across `lora_inspect` + `lora_merge`. Returns the
/// resolved `PathBuf` on success.
fn validate_lora_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("lora_path length out of range".into());
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("lora_path must be absolute".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if ext.as_deref() != Some("safetensors") {
        return Err("lora_path must end in .safetensors".into());
    }
    let md = std::fs::metadata(&p).map_err(|e| format!("lora_path not found: {e}"))?;
    if !md.is_file() {
        return Err("lora_path is not a regular file".into());
    }
    if md.len() > MAX_LORA_BYTES {
        return Err(format!(
            "lora file exceeds {} byte cap",
            MAX_LORA_BYTES
        ));
    }
    Ok(p)
}

fn validate_base_repo(base_repo: &str) -> Result<(), String> {
    if !ALLOWED_BASES.iter().any(|b| *b == base_repo) {
        return Err(format!(
            "kind:\"unsupported_base\" base_repo {base_repo} is not in the LoRA allowlist (Flux.1 dev/schnell only)"
        ));
    }
    Ok(())
}

fn validate_weight(weight: f32) -> Result<(), String> {
    if !weight.is_finite() {
        return Err("weight must be finite".into());
    }
    if !(0.0..=2.0).contains(&weight) {
        return Err("weight must be in [0.0, 2.0]".into());
    }
    Ok(())
}

fn validate_op_id(op_id: &str) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 64 {
        return Err("op_id length out of range".into());
    }
    if !OP_ID_RE.is_match(op_id) {
        return Err("op_id may only contain [A-Za-z0-9_-]".into());
    }
    Ok(())
}

/// Inspect a `.safetensors` LoRA file: convention, key count, triggers,
/// base hint. Heavy I/O bounded by the 4 GiB file cap and the safetensors
/// header parsing itself.
#[tauri::command]
pub async fn lora_inspect(lora_path: String) -> Result<LoraMetadata, String> {
    let path = validate_lora_path(&lora_path)?;
    super::blocking(move || lora::inspect(&path)).await
}

/// Drive one full merge. Returns the inserted row when the merge completes;
/// also emits `lora-merge-progress` / `lora-merge-done` / `lora-merge-error`
/// / `lora-merge-evicted` events along the way.
#[tauri::command]
pub async fn lora_merge(
    base_repo: String,
    lora_path: String,
    weight: f32,
    op_id: String,
    app: tauri::AppHandle,
) -> Result<LoraMergeRow, String> {
    validate_base_repo(&base_repo)?;
    let path = validate_lora_path(&lora_path)?;
    validate_weight(weight)?;
    validate_op_id(&op_id)?;

    // The merge runs on a blocking thread; progress events fire through
    // the captured `AppHandle::emit` directly from inside that thread so
    // the JS side sees real-time updates instead of a single end-of-merge
    // burst. AppHandle is Clone+Send+Sync, so it moves cleanly across the
    // spawn_blocking boundary.
    let app_for_emit = app.clone();
    let op_id_for_emit = op_id.clone();
    let base_for_blocking = base_repo.clone();

    let join_result = tokio::task::spawn_blocking(move || {
        lora::merge(
            &base_for_blocking,
            &path,
            weight,
            &op_id_for_emit,
            move |p| match p {
                MergeProgress::Evicted { sha } => {
                    let _ = app_for_emit
                        .emit("lora-merge-evicted", serde_json::json!({ "sha": sha }));
                }
                MergeProgress::Indexing => {
                    let _ = app_for_emit.emit(
                        "lora-merge-progress",
                        serde_json::json!({
                            "op_id": op_id_for_emit,
                            "stage": "indexing",
                            "progress": 1.0,
                        }),
                    );
                }
                other => {
                    if let (Some(stage), Some(progress)) =
                        (other.stage_name(), other.progress())
                    {
                        let _ = app_for_emit.emit(
                            "lora-merge-progress",
                            serde_json::json!({
                                "op_id": op_id_for_emit,
                                "stage": stage,
                                "progress": progress,
                            }),
                        );
                    }
                }
            },
        )
    })
    .await;

    match join_result {
        Ok(Ok(row)) => {
            let _ = app.emit(
                "lora-merge-done",
                serde_json::json!({ "op_id": op_id, "row": row }),
            );
            Ok(row)
        }
        Ok(Err(e)) => {
            let message = format!("{e:#}");
            let _ = app.emit(
                "lora-merge-error",
                serde_json::json!({ "op_id": op_id, "message": message }),
            );
            Err(message)
        }
        Err(e) => {
            let message = format!("merge task panicked: {e}");
            let _ = app.emit(
                "lora-merge-error",
                serde_json::json!({ "op_id": op_id, "message": message }),
            );
            Err(message)
        }
    }
}

/// List every cached merge row, newest first.
#[tauri::command]
pub async fn lora_list_merges() -> Result<Vec<LoraMergeRow>, String> {
    super::blocking(lora::list).await
}

/// Delete a cached merge by sha — drops the DB row and the on-disk dir.
#[tauri::command]
pub async fn lora_delete_merge(sha: String) -> Result<(), String> {
    if sha.is_empty() || sha.len() > 128 {
        return Err("sha length out of range".into());
    }
    super::blocking(move || lora::delete(&sha)).await
}

/// Touch `last_used_at = now()` for a sha. Used by the JS side after the
/// user applies a cached row so LRU eviction targets stale entries first.
#[tauri::command]
pub async fn lora_record_used(sha: String) -> Result<(), String> {
    if sha.is_empty() || sha.len() > 128 {
        return Err("sha length out of range".into());
    }
    super::blocking(move || lora::record_used(&sha)).await
}
