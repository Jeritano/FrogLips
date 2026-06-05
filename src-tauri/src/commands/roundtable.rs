//! Roundtable outcome persistence + file export — command layer.
//!
//! Outcomes (transcripts of completed roundtables) live in `db.sqlite` so they
//! survive restart. `roundtable_save_file` writes an exported transcript to a
//! user-chosen path through the same write-destination guard the DB backup uses,
//! so a saved transcript can't be steered into `~/.ssh` / credential dirs.

use super::blocking;
use super::path_safety::validate_write_dest;
use crate::roundtable;

#[tauri::command]
pub async fn roundtable_run_save(
    table_id: Option<String>,
    name: String,
    topic: String,
    turns: i64,
    transcript_json: String,
) -> Result<i64, String> {
    blocking(move || {
        roundtable::save_run(table_id.as_deref(), &name, &topic, turns, &transcript_json)
    })
    .await
}

#[tauri::command]
pub async fn roundtable_run_list(
    table_id: Option<String>,
) -> Result<Vec<roundtable::RoundtableRunSummary>, String> {
    blocking(move || roundtable::list_runs(table_id.as_deref())).await
}

#[tauri::command]
pub async fn roundtable_run_get(id: i64) -> Result<roundtable::RoundtableRun, String> {
    blocking(move || roundtable::get_run(id)).await
}

#[tauri::command]
pub async fn roundtable_run_delete(id: i64) -> Result<(), String> {
    blocking(move || roundtable::delete_run(id)).await
}

/// Write exported roundtable content (Markdown or JSON) to a user-chosen path.
/// `dest_path` comes from the system save dialog; it is re-validated here
/// (absolute-only, denylist, symlink-leaf refusal) before the write.
#[tauri::command]
pub async fn roundtable_save_file(dest_path: String, content: String) -> Result<(), String> {
    if content.len() > roundtable::MAX_TRANSCRIPT_BYTES {
        return Err(format!(
            "export exceeds {} bytes",
            roundtable::MAX_TRANSCRIPT_BYTES
        ));
    }
    let dest = validate_write_dest(&dest_path)?;
    blocking(move || {
        std::fs::write(&dest, content.as_bytes())
            .map_err(|e| anyhow::anyhow!("write {}: {e}", dest.display()))
    })
    .await
}
