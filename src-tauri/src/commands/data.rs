//! Database backup / export / import commands.
//!
//! Every path that crosses the IPC boundary here is validated by the shared
//! `path_safety` helpers — accepting an arbitrary user-supplied path with
//! only a trim/empty check would let a renderer-side bypass (XSS, hostile
//! MCP server driving the agent loop) write the SQLite DB or conversation
//! export anywhere the process can write, including `~/.ssh/`, `~/.aws/`,
//! the keychain, or `~/.env`. The helpers enforce absolute-only paths,
//! reject `..` traversal and symlinked leaves, and apply the same
//! denylist + credential-basename rules as `agent::fs::validate_for_write`.

use super::blocking;
use super::path_safety::{validate_read_src, validate_write_dest};
use crate::data_backup::{self, ImportSummary};

/// Write a consistent single-file backup of the live SQLite DB to `dest_path`.
/// Safe to invoke while the app is running.
#[tauri::command]
pub async fn backup_database(dest_path: String) -> Result<(), String> {
    let dest = validate_write_dest(&dest_path)?;
    blocking(move || data_backup::backup_database(&dest)).await
}

/// Export conversations, messages, and memory entries to a versioned JSON
/// document at `dest_path`.
#[tauri::command]
pub async fn export_data(dest_path: String) -> Result<(), String> {
    let dest = validate_write_dest(&dest_path)?;
    blocking(move || data_backup::export_data(&dest)).await
}

/// Import a JSON document produced by `export_data` into the live DB. Additive:
/// existing data is preserved; imported rows get fresh ids.
#[tauri::command]
pub async fn import_data(src_path: String) -> Result<ImportSummary, String> {
    let src = validate_read_src(&src_path)?;
    let result = blocking(move || data_backup::import_data(&src)).await;
    // Imports raw-insert memory rows the warm-once embedding cache never saw —
    // drop it so the next recall rebuilds from the freshly-imported DB.
    if result.is_ok() {
        crate::memory::invalidate_cache();
    }
    result
}
