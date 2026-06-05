//! Tauri command layer. Each `#[tauri::command]` wrapper is a thin adapter
//! between the IPC boundary and a domain module; they're grouped here by
//! domain. The `generate_handler!` registration stays in `lib.rs::run()`.

use once_cell::sync::Lazy;
use regex::Regex;
use std::sync::Arc;

pub mod agent;
pub mod claude_skills;
pub mod data;
pub mod history;
pub mod llmpm;
pub mod mcp;
pub mod modelscope;
pub mod memory;
pub mod misc;
pub mod models;
pub mod path_safety;
pub mod roundtable;
pub mod server;
pub mod workflow_skills;
pub mod workflows;

/* ── Shared handle types ── */

pub type ServerHandle = Arc<crate::backend_process::ServerState>;
pub type NativeHandle = crate::native_inference::SharedRuntime;

/* ── Input limits ── */
pub const MAX_MESSAGE_BYTES: usize = 1_048_576; // 1 MiB
pub const MAX_MEMORY_BYTES: usize = 16_384; // 16 KiB
pub const MAX_TITLE_LEN: usize = 200;
pub const MAX_TAGS_LEN: usize = 256;
pub const MAX_QUERY_LEN: usize = 256;
pub const MAX_EMBEDDING_DIMS: usize = 4096;
pub const MAX_RAG_NAME_LEN: usize = 128;
pub const MAX_RAG_QUERY_LEN: usize = 4096;

/// Hard cap on the JSON-encoded image payload per message. Generous enough to
/// hold 4 × 4 MiB PNGs at ~33% base64 overhead, but bounded so a malformed
/// IPC call can't blow up the SQLite row size budget.
pub const MAX_MESSAGE_IMAGES_BYTES: usize = 24 * 1024 * 1024;

/* ── Validators ── */
static OLLAMA_MODEL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._:@/-]+$").unwrap());
static HF_REPO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap());

/// Default IPC error formatter. Uses `format!("{e:#}")` so anyhow's
/// `.context("...")` chain renders in full at the renderer boundary —
/// previously this was `e.to_string()` which dropped every wrapper
/// context the crate carefully attaches in rag / models / lora /
/// history. Audit H-R3 (2026-05-27): consolidate on the chain-printing
/// formatter that the LoRA + image-gen IPCs already use directly.
pub fn map_err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Run a blocking closure on the blocking thread pool and flatten both the
/// join error and the closure's own error into a `String`. Collapses the
/// `spawn_blocking(...).await.map_err(...)?.map_err(...)` boilerplate that
/// ~30 commands repeated verbatim.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

pub fn validate_ollama_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 256 {
        return Err("ollama model name length out of range".into());
    }
    if name.starts_with('-') {
        return Err("ollama model name must not start with '-'".into());
    }
    if name.contains("..") {
        return Err("ollama model name must not contain '..'".into());
    }
    if !OLLAMA_MODEL_RE.is_match(name) {
        return Err("ollama model name has illegal characters".into());
    }
    Ok(())
}

pub fn validate_hf_repo(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        return Err("HF repo id length out of range".into());
    }
    if id.starts_with('-') || id.contains("..") {
        return Err("HF repo id must not start with '-' or contain '..'".into());
    }
    let base = id;
    if !HF_REPO_RE.is_match(base) {
        return Err("HF repo id must match org/name".into());
    }
    // Each segment must contain at least one alphanumeric (rules out names like "./.")
    for seg in base.split('/') {
        if !seg.chars().any(|c| c.is_ascii_alphanumeric()) {
            return Err("HF repo id segments must contain alphanumerics".into());
        }
    }
    Ok(())
}
