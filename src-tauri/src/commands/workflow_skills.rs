//! Procedural-memory command layer — thin adapter between the IPC boundary
//! and `crate::workflow_skills`. Validation lives in the domain module so
//! the wire format is just `(workflow_id, name, …) → result`.
//!
//! Errors are flattened to `String` (the Tauri convention) but `save` returns
//! a JSON-ish prefix like `kind: forbidden_step_tool: …` for the cases the
//! frontend / agent loop needs to branch on — see `SkillError` in
//! `crate::workflow_skills` for the kind taxonomy.

use super::blocking;
use crate::workflow_skills;

#[tauri::command]
pub async fn workflow_skill_save(
    workflow_id: i64,
    name: String,
    description: String,
    steps_json: String,
    overwrite: Option<bool>,
) -> Result<i64, String> {
    let overwrite = overwrite.unwrap_or(false);
    blocking(move || {
        workflow_skills::save(workflow_id, &name, &description, &steps_json, overwrite)
    })
    .await
}

#[tauri::command]
pub async fn workflow_skill_list(
    workflow_id: i64,
) -> Result<Vec<workflow_skills::SkillSummary>, String> {
    blocking(move || workflow_skills::list(workflow_id)).await
}

#[tauri::command]
pub async fn workflow_skill_get(
    workflow_id: i64,
    name: String,
) -> Result<Option<workflow_skills::SkillFull>, String> {
    blocking(move || workflow_skills::get(workflow_id, &name)).await
}

#[tauri::command]
pub async fn workflow_skill_delete(workflow_id: i64, name: String) -> Result<(), String> {
    blocking(move || workflow_skills::delete(workflow_id, &name)).await
}

#[tauri::command]
pub async fn workflow_skill_record_invocation(
    workflow_id: i64,
    name: String,
) -> Result<(), String> {
    blocking(move || workflow_skills::record_invocation(workflow_id, &name)).await
}
