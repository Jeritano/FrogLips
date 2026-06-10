//! Conversation + message persistence and branching commands.

use tauri::Emitter;

use super::{blocking, MAX_MESSAGE_BYTES, MAX_MESSAGE_IMAGES_BYTES, MAX_TITLE_LEN};
use crate::history;

#[tauri::command]
pub async fn list_conversations() -> Result<Vec<history::Conversation>, String> {
    blocking(history::list_conversations).await
}

#[tauri::command]
pub async fn create_conversation(title: String, model: Option<String>) -> Result<i64, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    blocking(move || history::create_conversation(&title, model.as_deref())).await
}

#[tauri::command]
pub async fn delete_conversation(id: i64) -> Result<(), String> {
    blocking(move || history::delete_conversation(id)).await
}

#[tauri::command]
pub async fn rename_conversation(id: i64, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    blocking(move || history::rename_conversation(id, &title)).await
}

#[tauri::command]
pub async fn list_messages(conversation_id: i64) -> Result<Vec<history::Message>, String> {
    blocking(move || history::list_messages(conversation_id)).await
}

#[tauri::command]
pub async fn add_message(
    conversation_id: i64,
    role: String,
    content: String,
    model: Option<String>,
    images_json: Option<String>,
    app: tauri::AppHandle,
) -> Result<i64, String> {
    if content.len() > MAX_MESSAGE_BYTES {
        return Err(format!("message exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    if !matches!(role.as_str(), "system" | "user" | "assistant") {
        return Err(format!("invalid role: {role}"));
    }
    if let Some(j) = images_json.as_deref() {
        if j.len() > MAX_MESSAGE_IMAGES_BYTES {
            return Err(format!(
                "images payload exceeds {MAX_MESSAGE_IMAGES_BYTES} bytes"
            ));
        }
    }
    let id = blocking(move || {
        history::add_message(
            conversation_id,
            &role,
            &content,
            model.as_deref(),
            images_json.as_deref(),
        )
    })
    .await?;
    // Multi-window sync: every persisted message is broadcast so any
    // detached window viewing the same conversation can re-fetch. Streaming
    // deltas are NOT broadcast (per design — only finalized messages cross
    // window boundaries to avoid token-by-token cross-window thrash).
    let _ = app.emit("conversation-updated", conversation_id);
    Ok(id)
}

#[tauri::command]
pub async fn delete_message(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    let conversation_id = blocking(move || history::delete_message(id)).await?;
    // Broadcast the real conversation id so a detached window viewing it refreshes.
    let _ = app.emit("conversation-updated", conversation_id);
    Ok(())
}

/// Persist per-conversation model params. `params` is either `null` (clears
/// the stored params) or a JSON-object string of the shape
/// `{ temperature, top_p, max_tokens, system_prompt }`. Malformed JSON is
/// rejected — the column never holds unparseable garbage.
#[tauri::command]
pub async fn update_conversation_params(id: i64, params: Option<String>) -> Result<(), String> {
    if let Some(p) = params.as_deref() {
        if p.len() > MAX_MESSAGE_BYTES {
            return Err("params payload too large".into());
        }
    }
    blocking(move || history::update_conversation_params(id, params.as_deref())).await
}

/// Fetch a single conversation by id, including its stored `params` JSON.
#[tauri::command]
pub async fn get_conversation(id: i64) -> Result<history::Conversation, String> {
    blocking(move || history::get_conversation(id)).await
}

/* ── Conversation organization ── */

/// Pin or unpin a conversation. Pinned conversations sort ahead of the rest.
#[tauri::command]
pub async fn set_conversation_pinned(id: i64, pinned: bool) -> Result<(), String> {
    blocking(move || history::set_conversation_pinned(id, pinned)).await
}

/// Set (or clear, with `null`) a conversation's tags. `tags` must be `null` or
/// a JSON-array-of-strings string; anything else is rejected.
#[tauri::command]
pub async fn set_conversation_tags(id: i64, tags: Option<String>) -> Result<(), String> {
    if let Some(t) = tags.as_deref() {
        if t.len() > MAX_MESSAGE_BYTES {
            return Err("tags payload too large".into());
        }
    }
    blocking(move || history::set_conversation_tags(id, tags.as_deref())).await
}

/// Search across message bodies, returning matching conversation ids with a
/// snippet of the matching message. Distinct from the title-only conversation
/// search.
#[tauri::command]
pub async fn search_messages(query: String) -> Result<Vec<history::MessageSearchHit>, String> {
    if query.len() > MAX_TITLE_LEN {
        return Err(format!("query exceeds {MAX_TITLE_LEN} chars"));
    }
    blocking(move || history::search_messages(&query)).await
}

/// Full-text message search (FTS5, BM25-ranked, snippeted) for the
/// Knowledge → History surface. Message-level hits, unlike `search_messages`
/// which returns one row per conversation for the sidebar filter.
#[tauri::command]
pub async fn search_messages_fts(
    query: String,
    limit: u32,
) -> Result<Vec<history::FtsMessageHit>, String> {
    blocking(move || history::search_messages_fts(&query, limit)).await
}

/* ── Conversation branching ── */

#[tauri::command]
pub async fn conversation_fork(source_id: i64, at_message_id: i64) -> Result<i64, String> {
    if at_message_id < 0 {
        return Err("at_message_id must be non-negative".into());
    }
    blocking(move || history::fork_conversation(source_id, at_message_id)).await
}

#[tauri::command]
pub async fn conversation_list_branches(conv_id: i64) -> Result<Vec<history::BranchInfo>, String> {
    blocking(move || history::list_branches(conv_id)).await
}

#[tauri::command]
pub async fn conversation_fork_tree(root_id: i64) -> Result<history::ForkTree, String> {
    blocking(move || history::get_fork_tree(root_id)).await
}
