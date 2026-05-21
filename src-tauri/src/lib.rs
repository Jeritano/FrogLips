mod agent;
mod agent_audit;
mod ask_user;
mod diagnostics;
mod gguf;
mod history;
mod mcp;
mod memory;
mod mlx_server;
mod models;
mod native_inference;
mod ollama_library;
mod policy;
mod quick_prompt;
mod rag;
mod settings;
mod task_queue;

use once_cell::sync::Lazy;
use regex::Regex;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

use mlx_server::{ServerState, ServerStatus};
use models::ModelEntry;

type ServerHandle = Arc<ServerState>;

/* ── Input limits ── */
const MAX_MESSAGE_BYTES: usize = 1_048_576; // 1 MiB
const MAX_MEMORY_BYTES: usize = 16_384; // 16 KiB
const MAX_TITLE_LEN: usize = 200;
const MAX_TAGS_LEN: usize = 256;
const MAX_QUERY_LEN: usize = 256;
const MAX_EMBEDDING_DIMS: usize = 4096;

/* ── Validators ── */
static OLLAMA_MODEL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._:@/-]+$").unwrap());
static HF_REPO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap());

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn validate_ollama_name(name: &str) -> Result<(), String> {
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

fn validate_hf_repo(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        return Err("HF repo id length out of range".into());
    }
    if id.starts_with('-') || id.contains("..") {
        return Err("HF repo id must not start with '-' or contain '..'".into());
    }
    if !HF_REPO_RE.is_match(id) {
        return Err("HF repo id must match org/name".into());
    }
    // Each segment must contain at least one alphanumeric (rules out names like "./.")
    for seg in id.split('/') {
        if !seg.chars().any(|c| c.is_ascii_alphanumeric()) {
            return Err("HF repo id segments must contain alphanumerics".into());
        }
    }
    Ok(())
}

#[tauri::command]
async fn start_server(
    model: String,
    backend: String,
    state: State<'_, ServerHandle>,
    app: tauri::AppHandle,
) -> Result<ServerStatus, String> {
    if backend != "mlx" && backend != "ollama" {
        return Err(format!("invalid backend: {backend}"));
    }
    if model.trim().is_empty() {
        return Err("model id must not be empty".into());
    }
    let status = state.start(model, backend).await.map_err(map_err)?;
    let _ = app.emit("server-status", &status);
    Ok(status)
}

#[tauri::command]
async fn stop_server(state: State<'_, ServerHandle>, app: tauri::AppHandle) -> Result<(), String> {
    state.stop().await;
    let _ = app.emit("server-status", &state.status().await);
    Ok(())
}

#[tauri::command]
async fn server_status(state: State<'_, ServerHandle>) -> Result<ServerStatus, String> {
    Ok(state.status().await)
}

#[derive(serde::Serialize)]
struct AllModels {
    mlx: Vec<ModelEntry>,
    ollama: Vec<ModelEntry>,
    mlx_error: Option<String>,
    ollama_error: Option<String>,
}

#[tauri::command]
async fn list_all_models() -> Result<AllModels, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let lists = models::list_all_models().map_err(map_err)?;
        Ok(AllModels {
            mlx: lists.mlx,
            ollama: lists.ollama,
            mlx_error: lists.mlx_error,
            ollama_error: lists.ollama_error,
        })
    })
    .await
    .map_err(map_err)?
}

#[tauri::command]
async fn delete_ollama_model(name: String) -> Result<(), String> {
    validate_ollama_name(&name)?;
    tokio::task::spawn_blocking(move || models::delete_ollama_model(&name))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn delete_mlx_model(repo_id: String) -> Result<(), String> {
    validate_hf_repo(&repo_id)?;
    tokio::task::spawn_blocking(move || models::delete_mlx_model(&repo_id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn pull_ollama_model(name: String) -> Result<String, String> {
    validate_ollama_name(&name)?;
    const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let fut = tokio::process::Command::new("ollama")
        .arg("pull")
        .arg("--")
        .arg(&name)
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(PULL_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs())),
    };
    if output.status.success() {
        Ok(format!("Pulled {name}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[tauri::command]
async fn ollama_library_fetch() -> Result<Vec<ollama_library::OllamaLibraryEntry>, String> {
    // Returns the cached/scraped contents of ollama.com/library. On failure
    // the frontend falls back to its curated `OLLAMA` array — never panics.
    ollama_library::fetch().await
}

#[tauri::command]
fn open_external(url: String, app: tauri::AppHandle) -> Result<(), String> {
    if url.len() > 2048 {
        return Err("url too long".into());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) urls allowed".into());
    }
    let parsed = url::Url::parse(&url).map_err(map_err)?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let allowed = matches!(
        host.as_str(),
        "civitai.com"
            | "www.civitai.com"
            | "huggingface.co"
            | "www.huggingface.co"
            | "ollama.com"
            | "www.ollama.com"
    );
    if !allowed {
        return Err(format!("host not allowed: {host}"));
    }
    // Use Apple's LaunchServices via tauri-plugin-opener (no exec) — avoids
    // argv-injection risk of shelling out to /usr/bin/open with the URL.
    app.opener().open_url(&url, None::<&str>).map_err(map_err)
}

#[tauri::command]
async fn pull_hf_model(repo_id: String) -> Result<String, String> {
    validate_hf_repo(&repo_id)?;
    let home = dirs::home_dir().unwrap_or_default();
    // Upper bound on a single attempt — 30 minutes is enough for any sane model
    // on a fast connection, and prevents the IPC command from hanging forever
    // if the CLI stalls on auth or network.
    const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let candidates: Vec<(std::path::PathBuf, &str)> = vec![
        (home.join(".venvs/mlx/bin/hf"), "download"),
        (std::path::PathBuf::from("hf"), "download"),
        (home.join(".venvs/mlx/bin/huggingface-cli"), "download"),
        (std::path::PathBuf::from("huggingface-cli"), "download"),
    ];
    let mut last_err = String::from("no huggingface CLI found");
    for (bin, sub) in candidates {
        if bin.is_absolute() && !bin.exists() {
            continue;
        }
        // kill_on_drop: if the timeout fires and we drop the future, the
        // child download is also killed instead of leaking and burning bandwidth.
        let fut = tokio::process::Command::new(&bin)
            .arg(sub)
            .arg("--")
            .arg(&repo_id)
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(PULL_TIMEOUT, fut).await {
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if output.status.success() && !stderr.contains("deprecated and no longer works") {
                    return Ok(format!("Downloaded {repo_id}"));
                }
                last_err = stderr.into_owned();
            }
            Ok(Err(e)) => {
                last_err = e.to_string();
            }
            Err(_) => {
                return Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs()));
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn list_conversations() -> Result<Vec<history::Conversation>, String> {
    tauri::async_runtime::spawn_blocking(history::list_conversations)
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn create_conversation(title: String, model: Option<String>) -> Result<i64, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        history::create_conversation(&title, model.as_deref())
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn delete_conversation(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || history::delete_conversation(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn rename_conversation(id: i64, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    tauri::async_runtime::spawn_blocking(move || history::rename_conversation(id, &title))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn list_messages(conversation_id: i64) -> Result<Vec<history::Message>, String> {
    tauri::async_runtime::spawn_blocking(move || history::list_messages(conversation_id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

/// Hard cap on the JSON-encoded image payload per message. Generous enough to
/// hold 4 × 4 MiB PNGs at ~33% base64 overhead, but bounded so a malformed
/// IPC call can't blow up the SQLite row size budget.
const MAX_MESSAGE_IMAGES_BYTES: usize = 24 * 1024 * 1024;

#[tauri::command]
async fn add_message(
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
    let id = tauri::async_runtime::spawn_blocking(move || {
        history::add_message(
            conversation_id,
            &role,
            &content,
            model.as_deref(),
            images_json.as_deref(),
        )
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)?;
    // Multi-window sync: every persisted message is broadcast so any
    // detached window viewing the same conversation can re-fetch. Streaming
    // deltas are NOT broadcast (per design — only finalized messages cross
    // window boundaries to avoid token-by-token cross-window thrash).
    let _ = app.emit("conversation-updated", conversation_id);
    Ok(id)
}

#[tauri::command]
async fn delete_message(id: i64, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || history::delete_message(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)?;
    // We don't know the conv id post-delete; broadcast id=-1 as a wildcard
    // "something changed, re-fetch if you care" hint. Receivers ignore
    // unknown ids (their conv id check fails) so the cost is one cheap
    // event per delete.
    let _ = app.emit("conversation-updated", -1i64);
    Ok(())
}

/* ── Conversation branching ── */

#[tauri::command]
async fn conversation_fork(source_id: i64, at_message_id: i64) -> Result<i64, String> {
    if at_message_id < 0 {
        return Err("at_message_id must be non-negative".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        history::fork_conversation(source_id, at_message_id)
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn conversation_list_branches(conv_id: i64) -> Result<Vec<history::BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || history::list_branches(conv_id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn conversation_fork_tree(root_id: i64) -> Result<history::ForkTree, String> {
    tauri::async_runtime::spawn_blocking(move || history::get_fork_tree(root_id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

/* ── Memory ── */

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn add_memory(
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
    tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn list_memories(status: Option<String>) -> Result<Vec<memory::Memory>, String> {
    tauri::async_runtime::spawn_blocking(move || memory::list_memories(status.as_deref()))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn delete_memory(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::delete_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn update_memory_status(id: i64, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "active" | "pending" | "archived") {
        return Err(format!("invalid status: {status}"));
    }
    tauri::async_runtime::spawn_blocking(move || memory::update_memory_status(id, &status))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn touch_memory(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::touch_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn touch_memories(ids: Vec<i64>) -> Result<(), String> {
    // SQLite SQLITE_MAX_VARIABLE_NUMBER is 999 on older builds; cap well under
    // that to stay safe even if rusqlite is downgraded.
    if ids.len() > 500 {
        return Err("too many ids (max 500)".into());
    }
    tauri::async_runtime::spawn_blocking(move || memory::touch_memories(&ids))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn search_memories_keyword(
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
    tauri::async_runtime::spawn_blocking(move || memory::search_keyword(&query, limit, &ctx))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn search_memories_vector(
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
    tauri::async_runtime::spawn_blocking(move || {
        memory::search_vector(embedding, limit, min_score, &ctx)
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn memory_promote(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::promote_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn memory_demote(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::demote_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn memory_set_context(
    id: i64,
    project_root: Option<String>,
    conv_id: Option<i64>,
) -> Result<(), String> {
    if let Some(pr) = &project_root {
        if pr.len() > 4096 {
            return Err("project_root too long".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        memory::set_memory_context(id, project_root.as_deref(), conv_id)
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn find_duplicate_memory(
    embedding: Vec<f32>,
    threshold: Option<f32>,
) -> Result<Option<i64>, String> {
    if embedding.len() > MAX_EMBEDDING_DIMS {
        return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
    }
    let threshold = threshold.unwrap_or(0.85);
    tauri::async_runtime::spawn_blocking(move || memory::find_duplicate(embedding, threshold))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

/* ── Agent tool commands ── */

#[tauri::command]
async fn agent_read_file(
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<agent::ReadResult, String> {
    agent::read_file(path, offset, limit).await
}

#[tauri::command]
async fn agent_list_dir(path: String) -> Result<agent::DirListing, String> {
    agent::list_dir(path).await
}

#[tauri::command]
async fn agent_run_shell(
    command: String,
    opts: Option<agent::ShellOpts>,
    op_id: Option<String>,
) -> Result<agent::ShellResult, String> {
    agent::run_shell(command, opts, op_id).await
}

#[tauri::command]
fn agent_cancel_shell(op_id: String) {
    agent::cancel_shell(op_id);
}

#[tauri::command]
async fn agent_write_file(path: String, content: String) -> Result<(), String> {
    agent::write_file(path, content).await
}

#[tauri::command]
async fn agent_edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<agent::EditResult, String> {
    agent::edit_file(path, old_string, new_string, replace_all).await
}

#[tauri::command]
async fn agent_file_exists(path: String) -> Result<agent::ExistsResult, String> {
    agent::file_exists(path).await
}

#[tauri::command]
async fn agent_search_files(
    path: String,
    pattern: String,
    glob: Option<String>,
    regex: Option<bool>,
) -> Result<agent::SearchResult, String> {
    agent::search_files(path, pattern, glob, regex).await
}

#[tauri::command]
async fn agent_multi_edit(
    path: String,
    edits: Vec<agent::EditOp>,
) -> Result<agent::MultiEditResult, String> {
    agent::multi_edit(path, edits).await
}

#[tauri::command]
async fn agent_git_status(path: Option<String>) -> Result<agent::GitResult, String> {
    agent::git_status(path).await
}

#[tauri::command]
async fn agent_git_diff(
    path: Option<String>,
    staged: Option<bool>,
) -> Result<agent::GitResult, String> {
    agent::git_diff(path, staged).await
}

#[tauri::command]
async fn agent_git_log(
    path: Option<String>,
    limit: Option<u32>,
) -> Result<agent::GitResult, String> {
    agent::git_log(path, limit).await
}

#[tauri::command]
async fn agent_git_show(
    reference: String,
    path: Option<String>,
) -> Result<agent::GitResult, String> {
    agent::git_show(reference, path).await
}

#[tauri::command]
async fn agent_git_branches(path: Option<String>) -> Result<agent::GitResult, String> {
    agent::git_branches(path).await
}

#[tauri::command]
async fn agent_git_commit(
    message: String,
    path: Option<String>,
) -> Result<agent::GitResult, String> {
    agent::git_commit(message, path).await
}

#[tauri::command]
async fn agent_web_fetch(url: String) -> Result<agent::WebFetchResult, String> {
    agent::web_fetch(url).await
}

#[tauri::command]
async fn agent_web_search(
    query: String,
    n: Option<usize>,
) -> Result<agent::WebSearchResult, String> {
    agent::web_search(query, n).await
}

#[tauri::command]
async fn agent_read_pdf(path: String, limit: Option<u64>) -> Result<agent::PdfResult, String> {
    agent::read_pdf(path, limit).await
}

#[tauri::command]
async fn agent_screenshot(out_path: Option<String>) -> Result<agent::ScreenshotResult, String> {
    agent::screenshot(out_path).await
}

#[tauri::command]
async fn agent_clipboard_get() -> Result<String, String> {
    agent::clipboard_get().await
}

#[tauri::command]
async fn agent_clipboard_set(text: String) -> Result<(), String> {
    agent::clipboard_set(text).await
}

#[tauri::command]
async fn agent_open_app(name: String) -> Result<(), String> {
    agent::open_app(name).await
}

#[tauri::command]
async fn agent_show_notification(title: String, body: String) -> Result<(), String> {
    agent::show_notification(title, body).await
}

#[tauri::command]
async fn agent_open_path_in_editor(path: String, line: Option<u32>) -> Result<String, String> {
    agent::open_path_in_editor(path, line).await
}

#[tauri::command]
async fn agent_applescript_run(script: String) -> Result<agent::ShellResult, String> {
    agent::applescript_run(script).await
}

#[tauri::command]
async fn agent_http_request(input: agent::HttpReqInput) -> Result<agent::HttpResp, String> {
    agent::http_request(input).await
}

#[tauri::command]
async fn agent_find_definition(
    symbol: String,
    path: Option<String>,
) -> Result<agent::SearchResult, String> {
    agent::find_definition(symbol, path).await
}

#[tauri::command]
async fn agent_find_references(
    symbol: String,
    path: Option<String>,
) -> Result<agent::SearchResult, String> {
    agent::find_references(symbol, path).await
}

#[tauri::command]
async fn agent_format_code(path: String) -> Result<agent::FormatResult, String> {
    agent::format_code(path).await
}

/* ── Browser automation ──────────────────────────────────────────────────── */

#[tauri::command]
async fn agent_browser_navigate(url: String) -> Result<agent::BrowserNavigateResult, String> {
    agent::browser::navigate(url).await
}

#[tauri::command]
async fn agent_browser_click(selector: String) -> Result<agent::BrowserOkResult, String> {
    agent::browser::click(selector).await
}

#[tauri::command]
async fn agent_browser_fill(
    selector: String,
    value: String,
) -> Result<agent::BrowserOkResult, String> {
    agent::browser::fill(selector, value).await
}

#[tauri::command]
async fn agent_browser_screenshot() -> Result<agent::BrowserScreenshotResult, String> {
    agent::browser::screenshot().await
}

#[tauri::command]
async fn agent_browser_get_text(
    selector: Option<String>,
) -> Result<agent::BrowserTextResult, String> {
    agent::browser::get_text(selector).await
}

#[tauri::command]
async fn agent_browser_close() -> Result<agent::BrowserOkResult, String> {
    agent::browser::close().await
}

/* ── Filesystem watcher ─────────────────────────────────────────────────── */

#[tauri::command]
async fn agent_watch_path(
    path: String,
    glob: Option<String>,
    debounce_ms: Option<u64>,
) -> Result<agent::fs_watcher::WatchHandle, String> {
    agent::fs_watcher::watch_path(path, glob, debounce_ms).await
}

#[tauri::command]
fn agent_list_watches() -> Vec<agent::fs_watcher::WatchInfo> {
    agent::fs_watcher::list_watches()
}

#[tauri::command]
async fn agent_poll_watch(
    id: String,
    since_ms: Option<u64>,
    max_events: Option<u32>,
) -> Result<agent::fs_watcher::WatchPoll, String> {
    agent::fs_watcher::poll_watch(id, since_ms, max_events).await
}

#[tauri::command]
fn agent_stop_watch(id: String) -> Result<(), String> {
    agent::fs_watcher::stop_watch(id)
}

/* ── Task queue ──────────────────────────────────────────────────────────── */

#[tauri::command]
fn task_create(command: String, cwd: Option<String>) -> Result<task_queue::TaskInfo, String> {
    task_queue::create(command, cwd)
}

#[tauri::command]
fn task_status(id: String) -> Result<task_queue::TaskInfo, String> {
    task_queue::status(&id).ok_or_else(|| format!("no task {id}"))
}

#[tauri::command]
fn task_list() -> Vec<task_queue::TaskInfo> {
    task_queue::list()
}

#[tauri::command]
fn task_cancel(id: String) -> Result<(), String> {
    task_queue::cancel(&id)
}

#[tauri::command]
fn task_prune(older_than_secs: Option<u64>) -> usize {
    task_queue::prune(older_than_secs.unwrap_or(3600))
}

/* ── ask_user ────────────────────────────────────────────────────────────── */

#[tauri::command]
async fn agent_ask_user(
    question: String,
    hint: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (req, rx) = ask_user::prepare(question, hint)?;
    let id = req.id.clone();
    let _ = app.emit("ask-user", &req);
    let result = ask_user::await_reply(rx, &id).await;
    if result.is_err() {
        let _ = app.emit("ask-user-cancel", &id);
    }
    result
}

#[tauri::command]
fn agent_ask_user_reply(id: String, answer: String) -> Result<(), String> {
    ask_user::reply(&id, answer)
}

#[tauri::command]
fn agent_ask_user_cancel(id: String) {
    ask_user::cancel(&id);
}

#[tauri::command]
fn agent_classify_shell(command: String) -> String {
    agent::classify_shell_risk(&command).to_string()
}

#[tauri::command]
fn policy_load(cwd: String) -> Option<policy::ProjectPolicy> {
    policy::load_for_cwd(std::path::Path::new(&cwd))
}

#[tauri::command]
fn policy_evaluate_shell(cwd: String, command: String) -> policy::Decision {
    match policy::load_for_cwd(std::path::Path::new(&cwd)) {
        Some(p) => policy::evaluate_shell(&command, &p),
        None => policy::Decision::NeedsConfirm,
    }
}

#[tauri::command]
fn policy_evaluate_write(cwd: String, path: String) -> policy::Decision {
    match policy::load_for_cwd(std::path::Path::new(&cwd)) {
        Some(p) => policy::evaluate_write(std::path::Path::new(&path), &p),
        None => policy::Decision::NeedsConfirm,
    }
}

#[tauri::command]
fn agent_classify_applescript(script: String) -> String {
    agent::classify_applescript_risk(&script).to_string()
}

#[tauri::command]
fn agent_classify_http(method: String, has_auth: bool) -> String {
    agent::classify_http_risk(&method, has_auth).to_string()
}

#[tauri::command]
fn agent_set_workspace(path: Option<String>) -> Result<Option<String>, String> {
    let result = agent::set_workspace_root(path)?;
    let mut s = settings::load();
    s.workspace_root = result.clone();
    let _ = settings::save(&s);
    Ok(result)
}

#[tauri::command]
fn agent_get_workspace() -> Option<String> {
    agent::get_workspace_root()
}

/* ── Multi-window: detached conversations ────────────────────────────── */

/// Stable, filesystem/label-safe label for a detached conversation window.
///
/// Tauri rejects labels containing slashes/whitespace and requires uniqueness,
/// so we derive the label deterministically from the conversation id. Reusing
/// the same convId twice intentionally yields the same label — that lets
/// `open_conversation_window` focus the existing window rather than crash on
/// duplicate-label.
fn detached_window_label(conversation_id: i64) -> String {
    format!("conv-{conversation_id}")
}

#[tauri::command]
async fn open_conversation_window(
    conversation_id: i64,
    title: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    open_conversation_window_impl(&app, conversation_id, title.as_deref())
}

/// Synchronous core for `open_conversation_window` so unit tests can exercise
/// the dedup-and-focus path without an async runtime. Generic over the Tauri
/// `Runtime` so `tauri::test::MockRuntime` can drive it in `#[cfg(test)]`.
fn open_conversation_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    conversation_id: i64,
    title: Option<&str>,
) -> Result<String, String> {
    let label = detached_window_label(conversation_id);
    // If a window with this label is already open, focus it and bail. This
    // mirrors Slack/VSCode behavior where double-detach reopens the existing
    // window instead of stacking duplicates.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }
    let display_title = match title {
        Some(t) if !t.trim().is_empty() => format!("Froglips — {}", t.trim()),
        _ => format!("Froglips — Conversation {conversation_id}"),
    };
    // URL: same frontend bundle, query-string toggles the detached single-conv
    // view. The hash fragment isn't used because Tauri's WebviewUrl::App
    // collapses query strings cleanly via `index.html?…`.
    let url_path = format!("index.html?detached=1&conversation_id={conversation_id}");
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_path.into()))
        .title(display_title)
        .inner_size(700.0, 500.0)
        .min_inner_size(420.0, 320.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

#[tauri::command]
fn list_open_conversation_windows(app: tauri::AppHandle) -> Vec<String> {
    list_open_conversation_windows_impl(&app)
}

fn list_open_conversation_windows_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Vec<String> {
    // Only return labels matching our convention so callers can map them
    // back to conversation ids. The main window's "main" label is filtered.
    app.webview_windows()
        .keys()
        .filter(|l| l.starts_with("conv-"))
        .cloned()
        .collect()
}

/* ── Native inference (alpha; behind `--features native-inference`) ───── */

type NativeHandle = native_inference::SharedRuntime;

#[tauri::command]
async fn native_supported() -> bool {
    native_inference::native_enabled()
}

#[tauri::command]
async fn native_load_model(
    model_id: String,
    state: tauri::State<'_, NativeHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !native_inference::native_enabled() {
        return Err(
            "native inference not compiled in (rebuild with --features native-inference)".into(),
        );
    }
    let _ = app.emit("native-loading", &model_id);
    let rt = native_inference::NativeRuntime::load(model_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let mut g = state.lock().await;
    *g = Some(rt);
    let _ = app.emit("native-loaded", &model_id);
    Ok(())
}

#[tauri::command]
async fn native_unload_model(state: tauri::State<'_, NativeHandle>) -> Result<(), String> {
    let mut g = state.lock().await;
    *g = None;
    Ok(())
}

#[tauri::command]
async fn native_current_model(
    state: tauri::State<'_, NativeHandle>,
) -> Result<Option<String>, String> {
    let g = state.lock().await;
    Ok(g.as_ref().map(|r| r.model_id().to_string()))
}

#[derive(serde::Deserialize)]
struct NativeChatArgs {
    op_id: String,
    messages: Vec<NativeMsg>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<usize>,
}

#[derive(serde::Deserialize)]
struct NativeMsg {
    role: String,
    content: String,
}

#[tauri::command]
async fn native_chat_stream(
    args: NativeChatArgs,
    state: tauri::State<'_, NativeHandle>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let rt_opt = state.lock().await.clone();
    let rt = rt_opt.ok_or("no model loaded — call native_load_model first")?;
    let op_id = args.op_id.clone();
    let app_for_chunks = app.clone();
    let on_chunk = move |chunk: String| {
        let _ = app_for_chunks.emit(&format!("native-chunk:{op_id}"), chunk);
    };
    let opts = native_inference::SamplingOpts {
        temperature: args.temperature,
        top_p: args.top_p,
        max_tokens: args.max_tokens,
    };
    let msgs: Vec<(String, String)> = args
        .messages
        .into_iter()
        .map(|m| (m.role, m.content))
        .collect();
    let final_text = rt
        .chat_stream(msgs, opts, on_chunk)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(&format!("native-done:{}", args.op_id), &final_text);
    Ok(final_text)
}

/* ── GGUF file picker (Phase 3 of cross-platform Native rollout) ───────── */

/// Resolve the app's data dir via the Tauri 2 `path()` API. Centralized so
/// the three gguf commands all agree on the parent dir.
fn app_data_dir_for(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir lookup failed: {e}"))
}

#[tauri::command]
async fn native_download_gguf(
    repo: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Surface validation errors before kicking off the download so the UI
    // can show a snappy inline error instead of waiting on a network round
    // trip just to fail.
    gguf::validate_repo(&repo).map_err(map_err)?;
    gguf::validate_filename(&filename).map_err(map_err)?;
    let app_data = app_data_dir_for(&app)?;
    let path = gguf::download(app.clone(), app_data, repo, filename)
        .await
        .map_err(map_err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn native_list_gguf_files(app: tauri::AppHandle) -> Result<Vec<gguf::GgufFile>, String> {
    let app_data = app_data_dir_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || gguf::list_files(&app_data).map_err(map_err))
        .await
        .map_err(map_err)?
}

#[tauri::command]
async fn native_delete_gguf(
    repo: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    gguf::validate_repo(&repo).map_err(map_err)?;
    gguf::validate_filename(&filename).map_err(map_err)?;
    let app_data = app_data_dir_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        gguf::delete_file(&app_data, &repo, &filename).map_err(map_err)
    })
    .await
    .map_err(map_err)?
}

/* ── MCP (Model Context Protocol) ─────────────────────────────────────── */

#[tauri::command]
async fn mcp_start_server(
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<mcp::ToolDescriptor>, String> {
    let args = args.unwrap_or_default();
    mcp::start_server(name, command, args, env)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_stop_server(name: String) -> Result<(), String> {
    mcp::stop_server(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_list_servers() -> Vec<mcp::ServerInfo> {
    mcp::list_servers()
}

#[tauri::command]
fn mcp_list_tools(name: String) -> Result<Vec<mcp::ToolDescriptor>, String> {
    mcp::list_tools(&name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Option<serde_json::Value>,
) -> Result<String, String> {
    let args = args.unwrap_or(serde_json::json!({}));
    mcp::call_tool(&server, &tool, args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_server_stderr(name: String) -> Option<String> {
    mcp::server_stderr(&name).await
}

#[tauri::command]
fn settings_get() -> settings::Settings {
    settings::load()
}

/* ── Quick prompt (menu-bar ephemeral prompt) ──────────────────────────── */

#[tauri::command]
async fn quick_prompt_submit(
    op_id: String,
    text: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 128 {
        return Err("invalid op_id".into());
    }
    quick_prompt::run(app, op_id, text).await
}

#[tauri::command]
fn quick_prompt_open(app: tauri::AppHandle) -> Result<(), String> {
    quick_prompt::ensure_window(&app).map_err(map_err)
}

#[tauri::command]
fn quick_prompt_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(quick_prompt::QUICK_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn settings_set(patch: serde_json::Value) -> Result<settings::Settings, String> {
    let mut current = serde_json::to_value(settings::load()).map_err(|e| e.to_string())?;
    if let (Some(c), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            c.insert(k.clone(), v.clone());
        }
    }
    let updated: settings::Settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
    settings::save(&updated).map_err(|e| e.to_string())?;
    Ok(updated)
}

/* ── First-run setup wizard ─────────────────────────────────────────────── */

/// Returns whether the user has dismissed the first-run setup wizard.
/// Absent flag → `false` (i.e. legacy installs without the field rerun the
/// wizard once, then it self-marks complete).
#[tauri::command]
fn setup_complete_get() -> bool {
    settings::load().setup_complete.unwrap_or(false)
}

/// Persists the wizard's completion flag. Two callers:
///   * the wizard's "Done" button → `true`
///   * the Settings panel "Re-run setup wizard" button → `false`
#[tauri::command]
fn setup_complete_set(value: bool) -> Result<(), String> {
    let mut s = settings::load();
    s.setup_complete = Some(value);
    settings::save(&s).map_err(|e| e.to_string())
}

/// Probe for an installed MLX server by attempting `mlx_lm.server --help`.
/// Returns Ok(true) if the binary exists on PATH and exits cleanly within
/// the timeout; Ok(false) on missing-binary / non-zero exit / timeout. We
/// never surface an Err here — the wizard treats "probe errored" the same
/// as "backend unavailable" and the user can still pick a different option.
#[tauri::command]
async fn mlx_probe() -> bool {
    const MLX_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
    let fut = tokio::process::Command::new("mlx_lm.server")
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    match tokio::time::timeout(MLX_PROBE_TIMEOUT, fut).await {
        Ok(Ok(status)) => status.success(),
        _ => false,
    }
}

/// Probe for a running Ollama daemon via the official tags endpoint with a
/// 1s hard ceiling. Hardcoded to localhost:11434 so there's no SSRF surface
/// (the URL isn't user-controlled). Any error → false.
#[tauri::command]
async fn ollama_probe() -> bool {
    const OLLAMA_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
    let client = match reqwest::Client::builder()
        .timeout(OLLAMA_PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/* ── Agent audit log ────────────────────────────────────────────────────── */

/* ── RAG (project knowledge) ────────────────────────────────────────── */

const MAX_RAG_NAME_LEN: usize = 128;
const MAX_RAG_QUERY_LEN: usize = 4096;

#[tauri::command]
async fn rag_ingest_folder(
    name: String,
    root: String,
    glob: Option<String>,
) -> Result<rag::IngestReport, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > MAX_RAG_NAME_LEN {
        return Err(format!("name length must be 1..={MAX_RAG_NAME_LEN}"));
    }
    if root.trim().is_empty() {
        return Err("root must not be empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        rag::ingest_folder(rag::IngestOpts {
            name: trimmed,
            root,
            glob,
        })
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn rag_search(
    corpus_name: String,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<rag::RagHit>, String> {
    if query.len() > MAX_RAG_QUERY_LEN {
        return Err(format!("query exceeds {MAX_RAG_QUERY_LEN} chars"));
    }
    let k = top_k.unwrap_or(5);
    tauri::async_runtime::spawn_blocking(move || rag::search(&corpus_name, &query, k))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn rag_list_corpora() -> Result<Vec<rag::CorpusInfo>, String> {
    tauri::async_runtime::spawn_blocking(rag::list_corpora)
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn rag_delete_corpus(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rag::delete_corpus(&name))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_audit_record(entry: agent_audit::AuditEntry) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || agent_audit::record(entry))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_audit_list(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<Vec<agent_audit::AuditRow>, String> {
    let filter = filter.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || agent_audit::list(filter))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_audit_purge(days: u32) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || agent_audit::purge_older_than(days))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_audit_stats() -> Result<agent_audit::AuditStats, String> {
    tauri::async_runtime::spawn_blocking(agent_audit::stats)
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_session_metrics_record(
    entry: agent_audit::SessionMetricsEntry,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || agent_audit::session_metrics_record(entry))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_session_metrics_query(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<Vec<agent_audit::SessionMetricsRow>, String> {
    let filter = filter.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || agent_audit::session_metrics_query(filter))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn agent_dashboard_summary(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<agent_audit::DashboardSummary, String> {
    let filter = filter.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || agent_audit::dashboard_summary(filter))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn ensure_path_for_gui() {
    // GUI apps launched from Finder/Dock get minimal PATH — extend so `ollama`,
    // `mlx_lm.server`, and other CLI tools installed in common dirs are findable.
    let extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    if let Some(home) = dirs::home_dir() {
        for sub in [".local/bin", ".cargo/bin", ".venvs/mlx/bin"] {
            let p = home.join(sub).to_string_lossy().into_owned();
            if !parts.contains(&p) {
                parts.push(p);
            }
        }
    }
    for p in extra {
        let s = p.to_string();
        if !parts.contains(&s) {
            parts.push(s);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

pub fn run() {
    ensure_path_for_gui();

    // Restore persisted workspace root, if any
    let persisted = settings::load();
    if let Some(ws) = persisted.workspace_root.clone() {
        let _ = agent::set_workspace_root(Some(ws));
    }

    // Auto-start configured MCP servers in the background. Failures are
    // logged but never block app launch — the app must boot even with zero
    // MCP servers configured or every one of them broken.
    let configured_mcp = persisted.mcp_servers.clone().unwrap_or_default();
    if !configured_mcp.is_empty() {
        tauri::async_runtime::spawn(async move {
            for cfg in configured_mcp {
                if !cfg.enabled {
                    continue;
                }
                let name = cfg.name.clone();
                let env_opt = if cfg.env.is_empty() {
                    None
                } else {
                    Some(cfg.env)
                };
                if let Err(e) = mcp::start_server(cfg.name, cfg.command, cfg.args, env_opt).await {
                    diagnostics::warn_with(
                        "mcp",
                        &format!("auto-start '{}' failed: {}", name, e),
                        serde_json::json!({ "server": name, "error": e.to_string() }),
                    );
                }
            }
        });
    }

    let server_state: ServerHandle = Arc::new(ServerState::default());
    let native_state: NativeHandle = native_inference::new_shared();

    // Global-shortcut plugin: Cmd+Shift+L toggles the quick-prompt window.
    // The handler closure receives the AppHandle, so we wake the window
    // without needing extra shared state.
    let global_shortcut_plugin = {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
        let quick_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyL);
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &quick_shortcut && event.state() == ShortcutState::Pressed {
                    quick_prompt::toggle_window(app);
                }
            })
            .build()
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_shortcut_plugin)
        .manage(server_state.clone())
        .manage(native_state.clone())
        .setup({
            let state = server_state.clone();
            move |app| {
                state.set_app(app.handle().clone());
                // Make the AppHandle available to the diagnostics bridge so
                // background tasks (MCP, RAG, agent workers) can emit
                // `app-diagnostics` events without threading a handle
                // through every call site.
                diagnostics::set_app_handle(app.handle().clone());
                let s = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let _ = s.status().await; // emits if child died
                    }
                });

                // Register the default Cmd+Shift+L hotkey. Failure is logged
                // but non-fatal — the tray menu "Quick Prompt" entry still
                // opens the window.
                {
                    use tauri_plugin_global_shortcut::{
                        Code, GlobalShortcutExt, Modifiers, Shortcut,
                    };
                    let sc = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyL);
                    if let Err(e) = app.global_shortcut().register(sc) {
                        eprintln!("[quick-prompt] failed to register Cmd+Shift+L: {e}");
                    }
                }

                let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quick_i =
                    MenuItem::with_id(app, "quick", "Quick Prompt (⇧⌘L)", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quick_i, &quit_i])?;
                let mut tray = TrayIconBuilder::new().menu(&menu);
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quick" => {
                        quick_prompt::toggle_window(app);
                    }
                    _ => {}
                })
                .build(app)?;
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            server_status,
            list_all_models,
            pull_ollama_model,
            pull_hf_model,
            ollama_library_fetch,
            delete_ollama_model,
            delete_mlx_model,
            open_external,
            list_conversations,
            create_conversation,
            delete_conversation,
            rename_conversation,
            list_messages,
            add_message,
            delete_message,
            conversation_fork,
            conversation_list_branches,
            conversation_fork_tree,
            add_memory,
            list_memories,
            delete_memory,
            update_memory_status,
            touch_memory,
            touch_memories,
            search_memories_keyword,
            search_memories_vector,
            find_duplicate_memory,
            memory_promote,
            memory_demote,
            memory_set_context,
            agent_read_file,
            agent_list_dir,
            agent_run_shell,
            agent_write_file,
            agent_edit_file,
            agent_file_exists,
            agent_search_files,
            agent_classify_shell,
            agent_classify_applescript,
            agent_classify_http,
            agent_set_workspace,
            agent_get_workspace,
            open_conversation_window,
            list_open_conversation_windows,
            agent_cancel_shell,
            agent_multi_edit,
            agent_git_status,
            agent_git_diff,
            agent_git_log,
            agent_git_show,
            agent_git_branches,
            agent_git_commit,
            agent_web_fetch,
            agent_web_search,
            agent_read_pdf,
            agent_screenshot,
            agent_clipboard_get,
            agent_clipboard_set,
            agent_open_app,
            agent_show_notification,
            agent_open_path_in_editor,
            agent_applescript_run,
            agent_http_request,
            agent_find_definition,
            agent_find_references,
            agent_format_code,
            agent_browser_navigate,
            agent_browser_click,
            agent_browser_fill,
            agent_browser_screenshot,
            agent_browser_get_text,
            agent_browser_close,
            agent_watch_path,
            agent_list_watches,
            agent_poll_watch,
            agent_stop_watch,
            task_create,
            task_status,
            task_list,
            task_cancel,
            task_prune,
            agent_ask_user,
            agent_ask_user_reply,
            agent_ask_user_cancel,
            settings_get,
            settings_set,
            setup_complete_get,
            setup_complete_set,
            mlx_probe,
            ollama_probe,
            native_supported,
            native_load_model,
            native_unload_model,
            native_current_model,
            native_chat_stream,
            native_download_gguf,
            native_list_gguf_files,
            native_delete_gguf,
            mcp_start_server,
            mcp_stop_server,
            mcp_list_servers,
            mcp_list_tools,
            mcp_call_tool,
            mcp_server_stderr,
            policy_load,
            policy_evaluate_shell,
            policy_evaluate_write,
            agent_audit_record,
            agent_audit_list,
            agent_audit_purge,
            agent_audit_stats,
            agent_session_metrics_record,
            agent_session_metrics_query,
            agent_dashboard_summary,
            rag_ingest_folder,
            rag_search,
            rag_list_corpora,
            rag_delete_corpus,
            quick_prompt_submit,
            quick_prompt_open,
            quick_prompt_hide,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // kill_on_drop on the child handles teardown; this is belt-and-suspenders
    let cleanup = server_state.clone();
    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let s = cleanup.clone();
            tauri::async_runtime::block_on(async move {
                s.stop().await;
                mcp::shutdown_all().await;
                agent::browser::shutdown().await;
            });
            agent::fs_watcher::shutdown_all();
        }
    });
}

#[cfg(test)]
mod multi_window_tests {
    use super::*;

    #[test]
    fn detached_label_is_stable_and_safe() {
        // Same id → same label (so dedup-by-label in open_conversation_window
        // can map convId back to an existing window).
        assert_eq!(detached_window_label(42), "conv-42");
        assert_eq!(detached_window_label(42), detached_window_label(42));
        // Negative ids are still label-safe (only alnum + '-').
        let label = detached_window_label(-1);
        assert!(label.starts_with("conv-"));
        assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn open_conversation_window_dedups_to_focus() {
        // Build a real-but-mocked Tauri app so we can exercise the
        // get_webview_window + WebviewWindowBuilder code paths.
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        // First open: builder runs, returns label.
        let first = open_conversation_window_impl(&handle, 7, Some("Hello"))
            .expect("first open should succeed");
        assert_eq!(first, "conv-7");

        // Second open with same id MUST NOT error on duplicate label —
        // it should detect the existing window and focus instead.
        let second = open_conversation_window_impl(&handle, 7, Some("Hello"))
            .expect("second open should focus, not crash");
        assert_eq!(second, "conv-7");

        // list_open_conversation_windows should report only conv-* labels
        // (excludes any "main" window). MockRuntime may or may not surface
        // the window — accept either, the load-bearing check is the
        // no-crash invariant above.
        let open = list_open_conversation_windows_impl(&handle);
        if !open.is_empty() {
            assert!(open.iter().any(|l| l == "conv-7"));
        }
    }
}
