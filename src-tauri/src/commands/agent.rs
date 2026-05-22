//! Agent tooling commands: filesystem, shell, web, git, system, code, browser,
//! filesystem watcher, task queue, ask-user, policy, RAG, and audit log.

use super::{blocking, MAX_RAG_NAME_LEN, MAX_RAG_QUERY_LEN};
use crate::{agent, agent_audit, approval, ask_user, policy, rag, task_queue};

/* ── Dangerous-tool capability gate ──────────────────────────────────────────
 * Dangerous tool commands take a single-use, short-TTL `approval` token. The
 * frontend mints one via `mint_tool_approval` only after the user confirms in
 * the dangerous-tool modal, then passes it through. This backstops the
 * frontend gate against accidental bypass / refactor drift — a new call site
 * that forgets to mint fails closed. It is NOT a defense against a fully
 * compromised renderer (the webview could mint its own token); that is an
 * inherent Tauri trust limit. See `approval.rs`. */

/// Mint a single-use approval token bound to `tool`. Wired from the frontend's
/// post-confirmation path; the returned string is passed to the matching
/// dangerous command as its `approval` argument.
///
/// For `agent_run_shell` the caller MUST additionally pass the `command`
/// string the user just approved — the token is then payload-bound to a
/// SHA-256 hash of that exact string so a token approved for `ls` cannot be
/// silently reused for `rm -rf`. For other tools `command` is ignored and
/// the token is bound to the bare tool name as before.
#[tauri::command]
pub fn mint_tool_approval(tool: String, command: Option<String>) -> String {
    if tool == "agent_run_shell" {
        // Bind to the SHA-256 of the exact command. Empty/missing command
        // here would mint a token bound to the hash of "" — still useless
        // unless the caller eventually runs an empty command (which the
        // length check in run_shell rejects), so we don't special-case it.
        let cmd = command.unwrap_or_default();
        let fp = shell_command_fingerprint(&cmd);
        approval::mint_with_binding(&tool, &fp)
    } else {
        approval::mint(&tool)
    }
}

/// SHA-256 hex of the exact command string. Used as the binding for shell
/// approval tokens so the approval is non-transferable across commands.
fn shell_command_fingerprint(command: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(command.as_bytes());
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/* ── Agent tool commands ── */

#[tauri::command]
pub async fn agent_read_file(
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<agent::ReadResult, String> {
    agent::read_file(path, offset, limit).await
}

#[tauri::command]
pub async fn agent_list_dir(path: String) -> Result<agent::DirListing, String> {
    agent::list_dir(path).await
}

#[tauri::command]
pub async fn agent_run_shell(
    command: String,
    opts: Option<agent::ShellOpts>,
    op_id: Option<String>,
    approval: String,
) -> Result<agent::ShellResult, String> {
    // Approval is bound to a SHA-256 hash of the exact command string: a
    // token approved for `ls` cannot be reused for `rm -rf` even within the
    // 60s TTL. The fingerprint is recomputed here from the command we are
    // about to run, so the frontend can't approve one string and execute
    // another.
    let fp = shell_command_fingerprint(&command);
    if !approval::consume_with_binding("agent_run_shell", &approval, &fp) {
        return Err("tool approval required or expired".into());
    }
    agent::run_shell(command, opts, op_id).await
}

#[tauri::command]
pub fn agent_cancel_shell(op_id: String) {
    agent::cancel_shell(op_id);
}

#[tauri::command]
pub async fn agent_write_file(
    path: String,
    content: String,
    approval: String,
) -> Result<(), String> {
    if !approval::consume("agent_write_file", &approval) {
        return Err("tool approval required or expired".into());
    }
    agent::write_file(path, content).await
}

#[tauri::command]
pub async fn agent_edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    approval: String,
) -> Result<agent::EditResult, String> {
    // edit_file mutates the filesystem just like write_file — require the
    // same single-use approval token so a refactor or new caller cannot
    // accidentally bypass the user confirmation gate.
    if !approval::consume("agent_edit_file", &approval) {
        return Err("tool approval required or expired".into());
    }
    agent::edit_file(path, old_string, new_string, replace_all).await
}

#[tauri::command]
pub async fn agent_file_exists(path: String) -> Result<agent::ExistsResult, String> {
    agent::file_exists(path).await
}

#[tauri::command]
pub async fn agent_search_files(
    path: String,
    pattern: String,
    glob: Option<String>,
    regex: Option<bool>,
) -> Result<agent::SearchResult, String> {
    agent::search_files(path, pattern, glob, regex).await
}

#[tauri::command]
pub async fn agent_multi_edit(
    path: String,
    edits: Vec<agent::EditOp>,
    approval: String,
) -> Result<agent::MultiEditResult, String> {
    // multi_edit is just a batched form of edit_file; same approval gate.
    if !approval::consume("agent_multi_edit", &approval) {
        return Err("tool approval required or expired".into());
    }
    agent::multi_edit(path, edits).await
}

#[tauri::command]
pub async fn agent_git_status(path: Option<String>) -> Result<agent::GitResult, String> {
    agent::git_status(path).await
}

#[tauri::command]
pub async fn agent_git_diff(
    path: Option<String>,
    staged: Option<bool>,
) -> Result<agent::GitResult, String> {
    agent::git_diff(path, staged).await
}

#[tauri::command]
pub async fn agent_git_log(
    path: Option<String>,
    limit: Option<u32>,
) -> Result<agent::GitResult, String> {
    agent::git_log(path, limit).await
}

#[tauri::command]
pub async fn agent_git_show(
    reference: String,
    path: Option<String>,
) -> Result<agent::GitResult, String> {
    agent::git_show(reference, path).await
}

#[tauri::command]
pub async fn agent_git_branches(path: Option<String>) -> Result<agent::GitResult, String> {
    agent::git_branches(path).await
}

#[tauri::command]
pub async fn agent_git_commit(
    message: String,
    path: Option<String>,
) -> Result<agent::GitResult, String> {
    agent::git_commit(message, path).await
}

#[tauri::command]
pub async fn agent_web_fetch(url: String) -> Result<agent::WebFetchResult, String> {
    agent::web_fetch(url).await
}

#[tauri::command]
pub async fn agent_web_search(
    query: String,
    n: Option<usize>,
) -> Result<agent::WebSearchResult, String> {
    agent::web_search(query, n).await
}

#[tauri::command]
pub async fn agent_read_pdf(path: String, limit: Option<u64>) -> Result<agent::PdfResult, String> {
    agent::read_pdf(path, limit).await
}

#[tauri::command]
pub async fn agent_screenshot(out_path: Option<String>) -> Result<agent::ScreenshotResult, String> {
    agent::screenshot(out_path).await
}

#[tauri::command]
pub async fn agent_clipboard_get() -> Result<String, String> {
    agent::clipboard_get().await
}

#[tauri::command]
pub async fn agent_clipboard_set(text: String) -> Result<(), String> {
    agent::clipboard_set(text).await
}

#[tauri::command]
pub async fn agent_open_app(name: String) -> Result<(), String> {
    agent::open_app(name).await
}

#[tauri::command]
pub async fn agent_show_notification(title: String, body: String) -> Result<(), String> {
    agent::show_notification(title, body).await
}

#[tauri::command]
pub async fn agent_open_path_in_editor(path: String, line: Option<u32>) -> Result<String, String> {
    agent::open_path_in_editor(path, line).await
}

#[tauri::command]
pub async fn agent_applescript_run(
    script: String,
    approval: String,
) -> Result<agent::ShellResult, String> {
    if !approval::consume("agent_applescript_run", &approval) {
        return Err("tool approval required or expired".into());
    }
    agent::applescript_run(script).await
}

#[tauri::command]
pub async fn agent_http_request(
    input: agent::HttpReqInput,
    approval: String,
) -> Result<agent::HttpResp, String> {
    if !approval::consume("agent_http_request", &approval) {
        return Err("tool approval required or expired".into());
    }
    agent::http_request(input).await
}

#[tauri::command]
pub async fn agent_find_definition(
    symbol: String,
    path: Option<String>,
) -> Result<agent::SearchResult, String> {
    agent::find_definition(symbol, path).await
}

#[tauri::command]
pub async fn agent_find_references(
    symbol: String,
    path: Option<String>,
) -> Result<agent::SearchResult, String> {
    agent::find_references(symbol, path).await
}

#[tauri::command]
pub async fn agent_format_code(path: String) -> Result<agent::FormatResult, String> {
    agent::format_code(path).await
}

/* ── Browser automation ──────────────────────────────────────────────────── */

#[tauri::command]
pub async fn agent_browser_navigate(url: String) -> Result<agent::BrowserNavigateResult, String> {
    agent::browser::navigate(url).await
}

#[tauri::command]
pub async fn agent_browser_click(selector: String) -> Result<agent::BrowserOkResult, String> {
    agent::browser::click(selector).await
}

#[tauri::command]
pub async fn agent_browser_fill(
    selector: String,
    value: String,
) -> Result<agent::BrowserOkResult, String> {
    agent::browser::fill(selector, value).await
}

#[tauri::command]
pub async fn agent_browser_screenshot() -> Result<agent::BrowserScreenshotResult, String> {
    agent::browser::screenshot().await
}

#[tauri::command]
pub async fn agent_browser_get_text(
    selector: Option<String>,
) -> Result<agent::BrowserTextResult, String> {
    agent::browser::get_text(selector).await
}

#[tauri::command]
pub async fn agent_browser_close() -> Result<agent::BrowserOkResult, String> {
    agent::browser::close().await
}

/* ── Filesystem watcher ─────────────────────────────────────────────────── */

#[tauri::command]
pub async fn agent_watch_path(
    path: String,
    glob: Option<String>,
    debounce_ms: Option<u64>,
) -> Result<agent::fs_watcher::WatchHandle, String> {
    agent::fs_watcher::watch_path(path, glob, debounce_ms).await
}

#[tauri::command]
pub fn agent_list_watches() -> Vec<agent::fs_watcher::WatchInfo> {
    agent::fs_watcher::list_watches()
}

#[tauri::command]
pub async fn agent_poll_watch(
    id: String,
    since_ms: Option<u64>,
    max_events: Option<u32>,
) -> Result<agent::fs_watcher::WatchPoll, String> {
    agent::fs_watcher::poll_watch(id, since_ms, max_events).await
}

#[tauri::command]
pub fn agent_stop_watch(id: String) -> Result<(), String> {
    agent::fs_watcher::stop_watch(id)
}

/* ── Task queue ──────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn task_create(command: String, cwd: Option<String>) -> Result<task_queue::TaskInfo, String> {
    task_queue::create(command, cwd)
}

#[tauri::command]
pub fn task_status(id: String) -> Result<task_queue::TaskInfo, String> {
    task_queue::status(&id).ok_or_else(|| format!("no task {id}"))
}

#[tauri::command]
pub fn task_list() -> Vec<task_queue::TaskInfo> {
    task_queue::list()
}

#[tauri::command]
pub fn task_cancel(id: String) -> Result<(), String> {
    task_queue::cancel(&id)
}

#[tauri::command]
pub fn task_prune(older_than_secs: Option<u64>) -> usize {
    task_queue::prune(older_than_secs.unwrap_or(3600))
}

/* ── ask_user ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn agent_ask_user(
    question: String,
    hint: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use tauri::Emitter;
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
pub fn agent_ask_user_reply(id: String, answer: String) -> Result<(), String> {
    ask_user::reply(&id, answer)
}

#[tauri::command]
pub fn agent_ask_user_cancel(id: String) {
    ask_user::cancel(&id);
}

/* ── Risk classification + policy ────────────────────────────────────────── */

#[tauri::command]
pub fn agent_classify_shell(command: String) -> String {
    agent::classify_shell_risk(&command).to_string()
}

#[tauri::command]
pub fn agent_classify_applescript(script: String) -> String {
    agent::classify_applescript_risk(&script).to_string()
}

#[tauri::command]
pub fn agent_classify_http(method: String, has_auth: bool) -> String {
    agent::classify_http_risk(&method, has_auth).to_string()
}

#[tauri::command]
pub fn policy_load(cwd: String) -> Option<policy::ProjectPolicy> {
    policy::load_for_cwd(std::path::Path::new(&cwd))
}

#[tauri::command]
pub fn policy_evaluate_shell(cwd: String, command: String) -> policy::Decision {
    match policy::load_for_cwd(std::path::Path::new(&cwd)) {
        Some(p) => policy::evaluate_shell(&command, &p),
        None => policy::Decision::NeedsConfirm,
    }
}

#[tauri::command]
pub fn policy_evaluate_write(cwd: String, path: String) -> policy::Decision {
    match policy::load_for_cwd(std::path::Path::new(&cwd)) {
        Some(p) => policy::evaluate_write(std::path::Path::new(&path), &p),
        None => policy::Decision::NeedsConfirm,
    }
}

/* ── Workspace root ──────────────────────────────────────────────────────── */

#[tauri::command]
pub fn agent_set_workspace(path: Option<String>) -> Result<Option<String>, String> {
    let result = agent::set_workspace_root(path)?;
    let mut s = crate::settings::load();
    s.workspace_root = result.clone();
    let _ = crate::settings::save(&s);
    Ok(result)
}

#[tauri::command]
pub fn agent_get_workspace() -> Option<String> {
    agent::get_workspace_root()
}

/* ── RAG (project knowledge) ────────────────────────────────────────── */

#[tauri::command]
pub async fn rag_ingest_folder(
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
    blocking(move || {
        rag::ingest_folder(rag::IngestOpts {
            name: trimmed,
            root,
            glob,
        })
    })
    .await
}

#[tauri::command]
pub async fn rag_search(
    corpus_name: String,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<rag::RagHit>, String> {
    if query.len() > MAX_RAG_QUERY_LEN {
        return Err(format!("query exceeds {MAX_RAG_QUERY_LEN} chars"));
    }
    let k = top_k.unwrap_or(5);
    blocking(move || rag::search(&corpus_name, &query, k)).await
}

#[tauri::command]
pub async fn rag_list_corpora() -> Result<Vec<rag::CorpusInfo>, String> {
    blocking(rag::list_corpora).await
}

#[tauri::command]
pub async fn rag_delete_corpus(name: String) -> Result<(), String> {
    blocking(move || rag::delete_corpus(&name)).await
}

/* ── Agent audit log ────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn agent_audit_record(entry: agent_audit::AuditEntry) -> Result<(), String> {
    blocking(move || agent_audit::record(entry)).await
}

#[tauri::command]
pub async fn agent_audit_list(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<Vec<agent_audit::AuditRow>, String> {
    let filter = filter.unwrap_or_default();
    blocking(move || agent_audit::list(filter)).await
}

#[tauri::command]
pub async fn agent_audit_purge(days: u32) -> Result<usize, String> {
    blocking(move || agent_audit::purge_older_than(days)).await
}

#[tauri::command]
pub async fn agent_audit_stats() -> Result<agent_audit::AuditStats, String> {
    blocking(agent_audit::stats).await
}

#[tauri::command]
pub async fn agent_session_metrics_record(
    entry: agent_audit::SessionMetricsEntry,
) -> Result<(), String> {
    blocking(move || agent_audit::session_metrics_record(entry)).await
}

#[tauri::command]
pub async fn agent_session_metrics_query(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<Vec<agent_audit::SessionMetricsRow>, String> {
    let filter = filter.unwrap_or_default();
    blocking(move || agent_audit::session_metrics_query(filter)).await
}

#[tauri::command]
pub async fn agent_dashboard_summary(
    filter: Option<agent_audit::AuditFilter>,
) -> Result<agent_audit::DashboardSummary, String> {
    let filter = filter.unwrap_or_default();
    blocking(move || agent_audit::dashboard_summary(filter)).await
}
