//! Database backup / export / import commands.

use std::path::PathBuf;

use super::blocking;
use crate::data_backup::{self, ImportSummary};

fn checked_path(raw: &str, what: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{what} path must not be empty"));
    }
    Ok(PathBuf::from(trimmed))
}

/// Write a consistent single-file backup of the live SQLite DB to `dest_path`.
/// Safe to invoke while the app is running.
#[tauri::command]
pub async fn backup_database(dest_path: String) -> Result<(), String> {
    let dest = checked_path(&dest_path, "backup")?;
    blocking(move || data_backup::backup_database(&dest)).await
}

/// Export conversations, messages, and memory entries to a versioned JSON
/// document at `dest_path`.
#[tauri::command]
pub async fn export_data(dest_path: String) -> Result<(), String> {
    let dest = checked_path(&dest_path, "export")?;
    blocking(move || data_backup::export_data(&dest)).await
}

/// Import a JSON document produced by `export_data` into the live DB. Additive:
/// existing data is preserved; imported rows get fresh ids.
#[tauri::command]
pub async fn import_data(src_path: String) -> Result<ImportSummary, String> {
    let src = checked_path(&src_path, "import")?;
    blocking(move || data_backup::import_data(&src)).await
}
