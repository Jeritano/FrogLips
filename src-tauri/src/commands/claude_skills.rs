//! Claude Skills command layer — thin adapter between the IPC boundary and
//! `crate::claude_skills`. Validation lives in the domain module so the wire
//! format is just `(name | folder, …) → row`.
//!
//! Errors flatten to `String` (the Tauri convention) but the message embeds
//! the `kind:` tag from `claude_skills::SkillError` so the frontend can
//! branch on `bad_skill_md`, `bad_name`, `bad_description`, `body_too_large`,
//! or `name_collision`.

use std::path::PathBuf;

use super::blocking;
use crate::claude_skills;

#[tauri::command]
pub async fn claude_skill_import(
    folder_path: String,
    overwrite: Option<bool>,
) -> Result<claude_skills::ClaudeSkillRow, String> {
    let overwrite = overwrite.unwrap_or(false);
    blocking(move || claude_skills::import_from_folder(&PathBuf::from(folder_path), overwrite))
        .await
}

#[tauri::command]
pub async fn claude_skill_list(
    enabled_only: Option<bool>,
) -> Result<Vec<claude_skills::ClaudeSkillSummary>, String> {
    let enabled_only = enabled_only.unwrap_or(false);
    blocking(move || claude_skills::list(enabled_only)).await
}

#[tauri::command]
pub async fn claude_skill_get(
    name: String,
) -> Result<Option<claude_skills::ClaudeSkillRow>, String> {
    blocking(move || claude_skills::get(&name)).await
}

#[tauri::command]
pub async fn claude_skill_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    blocking(move || claude_skills::set_enabled(&name, enabled)).await
}

#[tauri::command]
pub async fn claude_skill_set_pinned(name: String, pinned: bool) -> Result<(), String> {
    blocking(move || claude_skills::set_pinned(&name, pinned)).await
}

#[tauri::command]
pub async fn claude_skill_delete(name: String) -> Result<(), String> {
    blocking(move || claude_skills::delete(&name)).await
}
