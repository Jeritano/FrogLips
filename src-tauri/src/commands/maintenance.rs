//! DB / storage maintenance IPC (WS4).

use super::blocking;
use crate::maintenance::{self, MaintenanceReport, MaintenanceStats, Trigger};
use crate::settings;

/// Cheap, read-only storage stats: db/wal/archive bytes + table row counts.
#[tauri::command]
pub async fn db_maintenance_stats() -> Result<MaintenanceStats, String> {
    blocking(maintenance::stats).await
}

/// Run the SAFE maintenance phases now (caps + archive + reclaim). Never
/// VACUUMs. Uses the user's configured policy (or conservative defaults).
#[tauri::command]
pub async fn db_maintenance_run() -> Result<MaintenanceReport, String> {
    blocking(|| {
        let cfg = settings::load().maintenance.unwrap_or_default();
        Ok(maintenance::run_maintenance(&cfg, Trigger::Manual))
    })
    .await
}

/// Explicit, heavy reclaim: runs the safe phases AND a full `VACUUM`. Takes a
/// global DB lock for the duration; this is the ONLY path that VACUUMs.
#[tauri::command]
pub async fn db_maintenance_vacuum() -> Result<MaintenanceReport, String> {
    blocking(|| {
        let cfg = settings::load().maintenance.unwrap_or_default();
        Ok(maintenance::run_maintenance(&cfg, Trigger::Vacuum))
    })
    .await
}

/// Recovery: restore every archived message for a conversation back into the
/// live DB. Returns the number of messages restored.
#[tauri::command]
pub async fn db_maintenance_restore_archived(conversation_id: i64) -> Result<usize, String> {
    blocking(move || maintenance::restore_archived(conversation_id)).await
}
