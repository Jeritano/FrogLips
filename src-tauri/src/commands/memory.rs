//! Long-term memory store commands (CRUD, search, promotion).

use super::{blocking, MAX_EMBEDDING_DIMS, MAX_MEMORY_BYTES, MAX_QUERY_LEN, MAX_TAGS_LEN};
use crate::memory;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn add_memory(
    content: String,
    conversation_id: Option<i64>,
    source_msg_id: Option<i64>,
    tags: Option<String>,
    embedding: Option<Vec<f32>>,
    status: Option<String>,
    scope: Option<String>,
    project_root: Option<String>,
) -> Result<i64, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("memory content empty".into());
    }
    if trimmed.len() > MAX_MEMORY_BYTES {
        return Err(format!("memory exceeds {MAX_MEMORY_BYTES} bytes"));
    }
    let st = status.as_deref().unwrap_or("active").to_string();
    if !matches!(st.as_str(), "active" | "pending" | "archived") {
        return Err(format!("invalid status: {st}"));
    }
    // Default scope='global' preserves legacy caller behavior (callers that
    // pre-date scopes still produce global memories).
    let sc = scope.as_deref().unwrap_or("global").to_string();
    if !matches!(sc.as_str(), "global" | "project" | "conversation") {
        return Err(format!("invalid scope: {sc}"));
    }
    let tags_s = tags.unwrap_or_default();
    if tags_s.len() > MAX_TAGS_LEN {
        return Err(format!("tags exceed {MAX_TAGS_LEN} chars"));
    }
    if tags_s.contains('\n') || tags_s.contains('\r') {
        return Err("tags must not contain newlines".into());
    }
    if let Some(emb) = &embedding {
        if emb.len() > MAX_EMBEDDING_DIMS {
            return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
        }
    }
    if let Some(pr) = &project_root {
        if pr.len() > 4096 {
            return Err("project_root too long".into());
        }
    }
    let content = trimmed.to_string();
    blocking(move || {
        memory::add_memory(
            &content,
            conversation_id,
            source_msg_id,
            &tags_s,
            embedding,
            &st,
            &sc,
            project_root.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_memories(
    status: Option<String>,
    cwd: Option<String>,
    conv_id: Option<i64>,
) -> Result<Vec<memory::Memory>, String> {
    // Honor the caller's scope so the memories panel doesn't surface entries
    // from other conversations / other workspaces. Same MemoryContext shape
    // the search paths use — missing cwd / conv_id degrades to "global-only"
    // via scope_matches in the memory layer.
    let ctx = memory::MemoryContext::new(cwd, conv_id);
    blocking(move || memory::list_memories(status.as_deref(), &ctx)).await
}

#[tauri::command]
pub async fn delete_memory(id: i64) -> Result<(), String> {
    blocking(move || memory::delete_memory(id)).await
}

#[tauri::command]
pub async fn update_memory_status(id: i64, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "active" | "pending" | "archived") {
        return Err(format!("invalid status: {status}"));
    }
    blocking(move || memory::update_memory_status(id, &status)).await
}

#[tauri::command]
pub async fn touch_memory(id: i64) -> Result<(), String> {
    blocking(move || memory::touch_memory(id)).await
}

#[tauri::command]
pub async fn touch_memories(ids: Vec<i64>) -> Result<(), String> {
    // SQLite SQLITE_MAX_VARIABLE_NUMBER is 999 on older builds; cap well under
    // that to stay safe even if rusqlite is downgraded.
    if ids.len() > 500 {
        return Err("too many ids (max 500)".into());
    }
    blocking(move || memory::touch_memories(&ids)).await
}

#[tauri::command]
pub async fn search_memories_keyword(
    query: String,
    limit: Option<i64>,
    cwd: Option<String>,
    conv_id: Option<i64>,
) -> Result<Vec<memory::Memory>, String> {
    if query.len() > MAX_QUERY_LEN {
        return Err(format!("query exceeds {MAX_QUERY_LEN} chars"));
    }
    let limit = limit.unwrap_or(5).clamp(1, 50);
    // Missing cwd / conv_id degrades to "global-only" via scope_matches —
    // never crashes on absent context (per spec).
    let ctx = memory::MemoryContext::new(cwd, conv_id);
    blocking(move || memory::search_keyword(&query, limit, &ctx)).await
}

#[tauri::command]
pub async fn search_memories_vector(
    embedding: Vec<f32>,
    limit: Option<i64>,
    min_score: Option<f32>,
    cwd: Option<String>,
    conv_id: Option<i64>,
) -> Result<Vec<memory::Memory>, String> {
    if embedding.len() > MAX_EMBEDDING_DIMS {
        return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
    }
    let limit = limit.unwrap_or(5).clamp(1, 50) as usize;
    let min_score = min_score.unwrap_or(0.55);
    let ctx = memory::MemoryContext::new(cwd, conv_id);
    blocking(move || memory::search_vector(embedding, limit, min_score, &ctx)).await
}

#[tauri::command]
pub async fn memory_promote(id: i64) -> Result<(), String> {
    blocking(move || memory::promote_memory(id)).await
}

#[tauri::command]
pub async fn memory_demote(id: i64) -> Result<(), String> {
    blocking(move || memory::demote_memory(id)).await
}

#[tauri::command]
pub async fn memory_set_context(
    id: i64,
    project_root: Option<String>,
    conv_id: Option<i64>,
) -> Result<(), String> {
    if let Some(pr) = &project_root {
        if pr.len() > 4096 {
            return Err("project_root too long".into());
        }
    }
    blocking(move || memory::set_memory_context(id, project_root.as_deref(), conv_id)).await
}

#[tauri::command]
pub async fn find_duplicate_memory(
    embedding: Vec<f32>,
    threshold: Option<f32>,
) -> Result<Option<i64>, String> {
    if embedding.len() > MAX_EMBEDDING_DIMS {
        return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
    }
    let threshold = threshold.unwrap_or(0.85);
    blocking(move || memory::find_duplicate(embedding, threshold)).await
}

/// Drop the in-memory embedding cache. Called when the embedding model changes:
/// vectors cached under the old model must not be compared against new-model
/// query embeddings (different dimension/semantics → broken dedup + recall).
/// Review finding 2026-06 — the TS-side LRU was cleared but this wasn't.
#[tauri::command]
pub fn memory_invalidate_embedding_cache() {
    memory::invalidate_cache();
}
