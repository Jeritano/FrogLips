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

/// Roots a Claude-skill folder is allowed to live under. Without this gate a
/// compromised renderer could ask the IPC to read a SKILL.md from anywhere
/// on disk and stash its contents in the DB — then pin it as a system
/// prompt addition on the next chat. Audit H-R5 (2026-05-27).
fn validate_skill_folder(folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty() || folder.len() > 4096 {
        return Err("kind:bad_path | message:folder path length out of range".into());
    }
    if folder.contains('\0') {
        return Err("kind:bad_path | message:folder path contains NUL".into());
    }
    let raw = PathBuf::from(folder);
    if !raw.is_absolute() {
        return Err("kind:bad_path | message:folder path must be absolute".into());
    }
    // Reject explicit traversal in the source string outright. Canonicalize
    // is run inside the module on `<folder>/SKILL.md` once we know the
    // root is allowed.
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("kind:bad_path | message:folder path may not contain '..'".into());
    }

    // Allow-list of acceptable roots. Anything under the user's home is
    // fine — that's where Claude/Anthropic install skills and where users
    // store their own — but reject /private, /var, /System, /Library
    // (system internals + browser caches that could exfiltrate
    // unrelated SKILL.md files placed by other apps).
    let home_raw = dirs::home_dir()
        .ok_or_else(|| "kind:bad_path | message:no home directory resolved".to_string())?;
    // Canonicalize BOTH sides — a host where $HOME itself contains a
    // symlink component (uncommon on macOS but possible after custom
    // user-dir setup) would false-reject every import without this.
    // Audit re-review LOW (2026-05-28).
    let home = std::fs::canonicalize(&home_raw).unwrap_or(home_raw);
    let canonical = std::fs::canonicalize(&raw)
        .map_err(|e| format!("kind:bad_path | message:folder path inaccessible: {e}"))?;
    if !canonical.starts_with(&home) {
        return Err(format!(
            "kind:bad_path | message:folder must live under {} (got {})",
            home.display(),
            canonical.display(),
        ));
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn claude_skill_import(
    folder_path: String,
    overwrite: Option<bool>,
) -> Result<claude_skills::ClaudeSkillRow, String> {
    let overwrite = overwrite.unwrap_or(false);
    let canonical = validate_skill_folder(&folder_path)?;
    blocking(move || claude_skills::import_from_folder(&canonical, overwrite)).await
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
