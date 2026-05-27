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

/// Payload that the frontend passes alongside a `mint_tool_approval` call so
/// the resulting token is bound not just to the tool name but to the exact
/// arguments the user confirmed. A token approved for `write_file("a.txt")`
/// must not be silently spendable on `write_file("~/.bashrc")`. Each
/// dangerous tool family has its own payload shape; the unused fields
/// default to `None`.
///
/// `tag` is a frontend-supplied tag — currently unused by the binding but
/// reserved so the renderer can disambiguate two different intents that
/// happen to share the same payload (e.g. an undo-vs-redo). It is NOT
/// trusted as a security boundary; the payload is the boundary.
#[derive(Debug, Default, serde::Deserialize)]
pub struct ApprovalPayload {
    pub command: Option<String>,
    pub path: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub url: Option<String>,
    pub pid: Option<i32>,
    pub signal: Option<String>,
    pub text: Option<String>,
    pub bundle_id: Option<String>,
    pub script: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub mcp_command: Option<String>,
    pub mcp_args: Option<Vec<String>>,
    pub mcp_env_keys: Option<Vec<String>>,
}

/// Mint a single-use approval token bound to `tool`. Wired from the frontend's
/// post-confirmation path; the returned string is passed to the matching
/// dangerous command as its `approval` argument.
///
/// Each dangerous tool family declares the subset of `payload` fields it
/// requires; the token is bound to a SHA-256 of those fields' canonical
/// serialization so the approval is non-transferable across argument
/// changes. New families MUST be added to `binding_for()` and to the matching
/// command's `consume_with_binding` call site (compile-time fail-closed: a
/// command that opts in but forgets the matching consume side will reject
/// every token).
///
/// `payload` is optional for backwards compat: tool names not listed in
/// `binding_for` mint an unbound token via `approval::mint`.
#[tauri::command]
pub fn mint_tool_approval(
    tool: String,
    command: Option<String>,
    payload: Option<ApprovalPayload>,
) -> Result<String, String> {
    // Back-compat: the original signature took only `command`. New call
    // sites use `payload`; legacy ones (still in flight on tauri-api.ts at
    // commit time) keep working via the synthetic merge below.
    let mut p = payload.unwrap_or_default();
    if p.command.is_none() {
        p.command = command;
    }
    match binding_for(&tool, &p) {
        Some(fp) => approval::mint_with_binding(&tool, &fp),
        None => approval::mint(&tool),
    }
}

/// SHA-256 hex of a canonical, separator-collision-proof encoding of the
/// payload fields the tool cares about. Each field is length-prefixed so
/// a value containing the separator can never collide with a different
/// field split (sec re-review M-NEW-1).
///
/// Encoding shape: `&lt;len&gt;:&lt;name&gt;=&lt;value&gt;\x1f` repeated for each field,
/// where `len` is the byte length of `value`. A field whose value contains
/// `\x1f` is fully captured because the parser reads exactly `len` bytes.
/// `\x1f` between fields is just a visual separator; the length-prefix is
/// the actual boundary.
pub(crate) fn binding_for(tool: &str, p: &ApprovalPayload) -> Option<String> {
    match tool {
        "agent_run_shell" => Some(sha256_hex(&kv(&[(
            "command",
            p.command.as_deref().unwrap_or(""),
        )]))),
        // Path-family: write / edit / multi_edit / make_dir / delete /
        // open_in_editor / format_code all bind to a single path.
        "agent_write_file"
        | "agent_edit_file"
        | "agent_multi_edit"
        | "agent_make_dir"
        | "agent_delete_path"
        | "agent_open_path_in_editor"
        | "agent_format_code" => Some(sha256_hex(&kv(&[(
            "path",
            p.path.as_deref().unwrap_or(""),
        )]))),
        // Two-path family: move + copy.
        "agent_move_path" | "agent_copy_path" => Some(sha256_hex(&kv(&[
            ("from", p.from.as_deref().unwrap_or("")),
            ("to", p.to.as_deref().unwrap_or("")),
        ]))),
        // Undo restores the most-recent snapshot — the path isn't known
        // until pop time, so bind to a synthetic marker that at least ties
        // the token to "this minted-for-undo intent" (single-use binding
        // still prevents stale token replay of a different family).
        "agent_undo_last" => Some(sha256_hex(&kv(&[("op", "undo_last")]))),
        // Process family.
        "agent_kill_process" => {
            let signal = p.signal.as_deref().unwrap_or("TERM").to_ascii_uppercase();
            let pid_str = p.pid.unwrap_or(-1).to_string();
            Some(sha256_hex(&kv(&[("pid", &pid_str), ("signal", &signal)])))
        }
        // Clipboard write — bound to the exact text the user confirmed.
        "agent_clipboard_set" => Some(sha256_hex(&kv(&[(
            "text",
            p.text.as_deref().unwrap_or(""),
        )]))),
        // App-launch — bound to the bundle id / app name.
        "agent_open_app" => Some(sha256_hex(&kv(&[(
            "app",
            p.bundle_id.as_deref().unwrap_or(""),
        )]))),
        // Notification — bound to BOTH title + body as independent fields.
        // Old `text="${title}\x1f${body}"` was collision-prone (M-NEW-1).
        "agent_show_notification" => Some(sha256_hex(&kv(&[
            ("title", p.title.as_deref().unwrap_or("")),
            ("body", p.body.as_deref().unwrap_or("")),
        ]))),
        // AppleScript — sec re-review H-1: previously unbound. AppleScript
        // is strictly more powerful than agent_run_shell (it can issue
        // `do shell script` plus drive any scriptable app), so it
        // absolutely needs payload binding.
        "agent_applescript_run" => Some(sha256_hex(&kv(&[(
            "script",
            p.script.as_deref().unwrap_or(""),
        )]))),
        // Screenshot: bind to a path target so a token issued for
        // "save to ~/Desktop/x.png" can't be reused for a different dest.
        "agent_screenshot" => Some(sha256_hex(&kv(&[(
            "path",
            p.path.as_deref().unwrap_or(""),
        )]))),
        // HTTP + browser — URL-bound.
        "agent_http_request" | "agent_web_fetch" | "agent_browser_navigate" => {
            Some(sha256_hex(&kv(&[("url", p.url.as_deref().unwrap_or(""))])))
        }
        // Browser per-action — sec re-review H-NEW-2: after navigate the
        // CDP session was driven without further approval. Each
        // click/fill/screenshot/get_text/close is now bound to its target
        // selector + value where applicable so the user explicitly
        // approves each on-page action, not just the navigation.
        "agent_browser_click" => Some(sha256_hex(&kv(&[(
            "selector",
            p.text.as_deref().unwrap_or(""),
        )]))),
        "agent_browser_fill" => Some(sha256_hex(&kv(&[
            ("selector", p.text.as_deref().unwrap_or("")),
            ("value", p.body.as_deref().unwrap_or("")),
        ]))),
        "agent_browser_get_text" => Some(sha256_hex(&kv(&[(
            "selector",
            p.text.as_deref().unwrap_or(""),
        )]))),
        "agent_browser_screenshot" => Some(sha256_hex(&kv(&[("op", "screenshot")]))),
        "agent_browser_close" => Some(sha256_hex(&kv(&[("op", "close")]))),
        // MCP server spawn — bind to command + args + env keys (NOT values,
        // since values may legitimately differ session to session but the
        // *capability* the user approves is the program + its arg vector).
        "mcp_start_server" => {
            // argv is semantically ordered (do NOT sort).
            let args_joined = p
                .mcp_args
                .as_deref()
                .map(|a| a.join("\u{1f}"))
                .unwrap_or_default();
            // env_keys MUST be sorted on BOTH sides — consume side
            // (`mcp::start_server`) sorts before hashing, and serde-JSON
            // round-trips can shuffle key order. Without symmetric sort
            // here, legitimate MCP starts fail with "approval expired"
            // on roughly half of calls. (Infra audit H1, 2026-05-24.)
            let env_joined = p
                .mcp_env_keys
                .as_deref()
                .map(|k| {
                    let mut sorted: Vec<String> = k.to_vec();
                    sorted.sort();
                    sorted.join("\u{1f}")
                })
                .unwrap_or_default();
            Some(sha256_hex(&kv(&[
                ("cmd", p.mcp_command.as_deref().unwrap_or("")),
                ("args", &args_joined),
                ("env_keys", &env_joined),
            ])))
        }
        _ => None,
    }
}

/// Length-prefixed canonical encoding of key/value pairs. Returns a string
/// like `7:command=ls -la\x1f` — the leading `&lt;len&gt;:` makes the boundary
/// unambiguous regardless of what the value contains.
///
/// Code re-review L-NEW-5: pairs are sorted by key before encoding so the
/// canonical form is independent of caller-side argument order. A future
/// contributor reordering arms in `binding_for` would otherwise silently
/// break mint/verify symmetry with no compile-time signal.
fn kv(pairs: &[(&str, &str)]) -> String {
    let mut sorted: Vec<&(&str, &str)> = pairs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut out = String::with_capacity(64 + sorted.iter().map(|(_, v)| v.len()).sum::<usize>());
    for (k, v) in sorted {
        use std::fmt::Write;
        let _ = write!(out, "{}:{}={}\u{1f}", v.len(), k, v);
    }
    out
}

/// SHA-256 hex of an arbitrary string. Used everywhere a binding is needed.
pub(crate) fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        use std::fmt::Write;
        let _ = write!(hex, "{b:02x}");
    }
    hex
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

/// Shared helper — rebuilds the binding for a tool family from its actual
/// IPC arguments and verifies the approval token. `recompute_binding` is
/// the source of truth on the consume side; the matching mint side lives
/// in `binding_for`. Both MUST produce the same canonical string for the
/// same logical payload — drift = silent reject of every legitimate call.
fn verify_bound(tool: &str, approval: &str, payload: ApprovalPayload) -> Result<(), String> {
    let Some(expected) = binding_for(tool, &payload) else {
        return Err(format!(
            "internal: tool {tool} has no binding declared but expected one"
        ));
    };
    if !approval::consume_with_binding(tool, approval, &expected) {
        return Err("tool approval required or expired".into());
    }
    Ok(())
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
    verify_bound(
        "agent_run_shell",
        &approval,
        ApprovalPayload {
            command: Some(command.clone()),
            ..Default::default()
        },
    )?;
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
    // Path-bound: a token approved for `notes.md` cannot be silently reused
    // to clobber `~/.bashrc` within the 60s TTL.
    verify_bound(
        "agent_write_file",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
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
    // same path-bound approval token so a refactor or new caller cannot
    // accidentally bypass the user confirmation gate AND so a token issued
    // for one file can't quietly be spent on another.
    verify_bound(
        "agent_edit_file",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
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
    // multi_edit is a batched form of edit_file; same path-bound approval.
    verify_bound(
        "agent_multi_edit",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
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
pub async fn agent_screenshot(
    out_path: Option<String>,
    approval: String,
) -> Result<agent::ScreenshotResult, String> {
    // Approval gate (sec review H4): a screenshot can expose any window the
    // user has open — bank, password manager, IDE, Slack — and the captured
    // bytes are then readable via `agent_read_file`. Always require explicit
    // confirmation, bound to the output path so a token for `~/x.png` can't
    // silently be reused for `~/Documents/secrets.png`.
    verify_bound(
        "agent_screenshot",
        &approval,
        ApprovalPayload {
            path: out_path.clone(),
            ..Default::default()
        },
    )?;
    agent::screenshot(out_path).await
}

#[tauri::command]
pub async fn agent_clipboard_get() -> Result<String, String> {
    agent::clipboard_get().await
}

#[tauri::command]
pub async fn agent_clipboard_set(text: String, approval: String) -> Result<(), String> {
    // Approval gate (sec review S-C2): clipboard hijack attack — a prompt-
    // injected model can silently overwrite the user's clipboard right
    // before they paste (bank account, password, address). Bind to the
    // exact text the user confirmed so a token for "hello" can't be reused
    // to set arbitrary text within the 60s TTL.
    verify_bound(
        "agent_clipboard_set",
        &approval,
        ApprovalPayload {
            text: Some(text.clone()),
            ..Default::default()
        },
    )?;
    agent::clipboard_set(text).await
}

#[tauri::command]
pub async fn agent_open_app(name: String, approval: String) -> Result<(), String> {
    // Approval gate (sec review S-C2): launching an arbitrary app is a real
    // capability — e.g. opening 1Password or System Settings under the
    // user's session. Bind to the app identifier so a token for `Calculator`
    // doesn't silently launch `Terminal`.
    verify_bound(
        "agent_open_app",
        &approval,
        ApprovalPayload {
            bundle_id: Some(name.clone()),
            ..Default::default()
        },
    )?;
    agent::open_app(name).await
}

#[tauri::command]
pub async fn agent_show_notification(
    title: String,
    body: String,
    approval: String,
) -> Result<(), String> {
    // Approval gate (sec review S-C2): notifications can phish — popping
    // "macOS Update Available — click here" is a real attack surface. Bind
    // to title + body as INDEPENDENT fields (sec re-review M-NEW-1 caught
    // the prior `"${title}\x1f${body}"` collision).
    verify_bound(
        "agent_show_notification",
        &approval,
        ApprovalPayload {
            title: Some(title.clone()),
            body: Some(body.clone()),
            ..Default::default()
        },
    )?;
    agent::show_notification(title, body).await
}

#[tauri::command]
pub async fn agent_open_path_in_editor(
    path: String,
    line: Option<u32>,
    approval: String,
) -> Result<String, String> {
    // Approval gate (sec review S-C2): opening a path in an external editor
    // (`code`, `cursor`, `open`) is a side-effect the user should see. Bind
    // to the path so a token for one file isn't silently reused.
    verify_bound(
        "agent_open_path_in_editor",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
    agent::open_path_in_editor(path, line).await
}

#[tauri::command]
pub async fn agent_applescript_run(
    script: String,
    approval: String,
) -> Result<agent::ShellResult, String> {
    // Sec re-review H-1: applescript_run is strictly more powerful than
    // run_shell (it can `do shell script` AND drive any scriptable app),
    // so it absolutely needs payload binding. Was previously the only
    // dangerous IPC still on the legacy bareword approval path.
    verify_bound(
        "agent_applescript_run",
        &approval,
        ApprovalPayload {
            script: Some(script.clone()),
            ..Default::default()
        },
    )?;
    agent::applescript_run(script).await
}

#[tauri::command]
pub async fn agent_http_request(
    input: agent::HttpReqInput,
    approval: String,
) -> Result<agent::HttpResp, String> {
    // URL-bound: a token approved for a public docs page can't be reused to
    // post to a metadata endpoint within the 60s TTL.
    verify_bound(
        "agent_http_request",
        &approval,
        ApprovalPayload {
            url: Some(input.url.clone()),
            ..Default::default()
        },
    )?;
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
pub async fn agent_format_code(
    path: String,
    approval: String,
) -> Result<agent::FormatResult, String> {
    // Path-bound approval gate (sec review L6 + S-C2 family): format_code
    // mutates the target file in place by shelling out to the platform
    // formatter (`prettier`, `rustfmt`, etc.). Without a gate it bypasses
    // every other approval the user has on file edits.
    verify_bound(
        "agent_format_code",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
    agent::format_code(path).await
}

/* ── Browser automation ──────────────────────────────────────────────────── */

#[tauri::command]
pub async fn agent_browser_navigate(
    url: String,
    approval: String,
) -> Result<agent::BrowserNavigateResult, String> {
    // Approval gate + URL-bound (sec review H3). The web_fetch path enforces
    // a private-range / link-local / metadata-IP denylist; the headless
    // browser tool previously bypassed that entirely (it has its own DNS
    // resolution, cookies, JS execution, and supports `file://`, `chrome://`,
    // etc.). We do BOTH here:
    //   1. Run the SSRF guard for HTTP(S) URLs and reject any non-HTTP(S)
    //      scheme outright (file://, chrome://, javascript:, data: are dead).
    //   2. Bind the approval token to the exact URL so a token for a public
    //      docs page can't be silently reused on `http://localhost:11434`.
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("scheme {other} not permitted for browser_navigate")),
    }
    if let Some(host) = parsed.host_str() {
        // Reuse the same SSRF host check the web tools use.
        if !agent::web::is_safe_public_host(host) {
            return Err(format!("host {host} is not permitted for browser_navigate"));
        }
    } else {
        return Err("url has no host".into());
    }
    verify_bound(
        "agent_browser_navigate",
        &approval,
        ApprovalPayload {
            url: Some(url.clone()),
            ..Default::default()
        },
    )?;
    agent::browser::navigate(url).await
}

// Sec re-review H-NEW-2: previously only browser_navigate was approval-
// gated. After the user approved a navigation to e.g. github.com the
// model could drive click/fill/get_text/screenshot/close without further
// consent — fill the password field, click "Authorize", or screenshot the
// logged-in account. Each interactive action is now bound to its target
// selector + value where applicable so the user explicitly approves
// each on-page action.

#[tauri::command]
pub async fn agent_browser_click(
    selector: String,
    approval: String,
) -> Result<agent::BrowserOkResult, String> {
    verify_bound(
        "agent_browser_click",
        &approval,
        ApprovalPayload {
            text: Some(selector.clone()),
            ..Default::default()
        },
    )?;
    agent::browser::click(selector).await
}

#[tauri::command]
pub async fn agent_browser_fill(
    selector: String,
    value: String,
    approval: String,
) -> Result<agent::BrowserOkResult, String> {
    verify_bound(
        "agent_browser_fill",
        &approval,
        ApprovalPayload {
            text: Some(selector.clone()),
            body: Some(value.clone()),
            ..Default::default()
        },
    )?;
    agent::browser::fill(selector, value).await
}

#[tauri::command]
pub async fn agent_browser_screenshot(
    approval: String,
) -> Result<agent::BrowserScreenshotResult, String> {
    verify_bound(
        "agent_browser_screenshot",
        &approval,
        ApprovalPayload::default(),
    )?;
    agent::browser::screenshot().await
}

#[tauri::command]
pub async fn agent_browser_get_text(
    selector: Option<String>,
    approval: String,
) -> Result<agent::BrowserTextResult, String> {
    verify_bound(
        "agent_browser_get_text",
        &approval,
        ApprovalPayload {
            text: selector.clone(),
            ..Default::default()
        },
    )?;
    agent::browser::get_text(selector).await
}

#[tauri::command]
pub async fn agent_browser_close(approval: String) -> Result<agent::BrowserOkResult, String> {
    verify_bound("agent_browser_close", &approval, ApprovalPayload::default())?;
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

// task_prune IPC removed 2026-05-26 SE review round 2 — no FE consumer.
// The opportunistic prune that actually runs lives at
// task_queue::create (AUTO_PRUNE_AFTER_SECS = 30 min). Re-add only if a
// user-facing "Clear finished tasks" button materializes.

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
    let previous = agent::get_workspace_root();
    let result = agent::set_workspace_root(path)?;
    let mut s = crate::settings::load();
    s.workspace_root = result.clone();
    let _ = crate::settings::save(&s);
    // Code re-review M-1: snapshot stack was documented as workspace-
    // scoped but `clear()` was never called from here. Switching projects
    // could otherwise let `agent_undo` later write into the old project.
    if previous != result {
        agent::snapshot::clear();
    }
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

/* ── extras: file ops + hash + diff + processes ──────────────────────────────
 * Auxiliary tools added so the model isn't forced through `agent_run_shell`
 * (with its per-call approval modal) for every basic file/system task. Each
 * destructive op stays approval-gated (move/copy/delete/kill); read-only
 * ones (list_processes, hash_file, diff_files) don't need a token. */

#[tauri::command]
pub async fn agent_move_path(
    from: String,
    to: String,
    overwrite: Option<bool>,
    approval: String,
) -> Result<agent::extras::FileOpResult, String> {
    verify_bound(
        "agent_move_path",
        &approval,
        ApprovalPayload {
            from: Some(from.clone()),
            to: Some(to.clone()),
            ..Default::default()
        },
    )?;
    agent::extras::move_path(from, to, overwrite.unwrap_or(false)).await
}

#[tauri::command]
pub async fn agent_copy_path(
    from: String,
    to: String,
    overwrite: Option<bool>,
    approval: String,
) -> Result<agent::extras::FileOpResult, String> {
    verify_bound(
        "agent_copy_path",
        &approval,
        ApprovalPayload {
            from: Some(from.clone()),
            to: Some(to.clone()),
            ..Default::default()
        },
    )?;
    agent::extras::copy_path(from, to, overwrite.unwrap_or(false)).await
}

#[tauri::command]
pub async fn agent_delete_path(
    path: String,
    recursive: Option<bool>,
    approval: String,
) -> Result<agent::extras::DeleteResult, String> {
    verify_bound(
        "agent_delete_path",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
    agent::extras::delete_path(path, recursive.unwrap_or(false)).await
}

#[tauri::command]
pub async fn agent_make_dir(
    path: String,
    approval: String,
) -> Result<agent::extras::MakeDirResult, String> {
    verify_bound(
        "agent_make_dir",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
    agent::extras::make_dir(path).await
}

#[tauri::command]
pub async fn agent_hash_file(
    path: String,
    algorithm: Option<String>,
) -> Result<agent::extras::HashResult, String> {
    agent::extras::hash_file(path, algorithm.unwrap_or_else(|| "sha256".into())).await
}

#[tauri::command]
pub async fn agent_diff_files(
    left: String,
    right: String,
) -> Result<agent::extras::DiffResult, String> {
    agent::extras::diff_files(left, right).await
}

#[tauri::command]
pub async fn agent_list_processes(
    filter: Option<String>,
) -> Result<Vec<agent::extras::ProcessRow>, String> {
    agent::extras::list_processes(filter).await
}

#[tauri::command]
pub async fn agent_kill_process(
    pid: i32,
    signal: Option<String>,
    approval: String,
) -> Result<agent::extras::KillResult, String> {
    // (pid, signal)-bound (sec review S-C3): a token approved for "TERM pid
    // 12345" cannot be reused inside the 60s TTL to kill an arbitrary pid.
    verify_bound(
        "agent_kill_process",
        &approval,
        ApprovalPayload {
            pid: Some(pid),
            signal: signal.clone(),
            ..Default::default()
        },
    )?;
    agent::extras::kill_process(agent::extras::KillRequest { pid, signal }).await
}

/* ── snapshot / undo ───────────────────────────────────────────────────────── */

#[tauri::command]
pub fn agent_list_undo() -> Vec<agent::snapshot::UndoEntry> {
    agent::snapshot::list_undo()
}

#[tauri::command]
pub fn agent_undo_last(approval: String) -> Result<agent::snapshot::UndoResult, String> {
    // Undo touches the filesystem so we route it through the dangerous-tool
    // gate. The frontend mints the token after a confirmation modal. Bound
    // to a synthetic "undo_last" marker so a token from another family
    // can't be replayed here.
    verify_bound("agent_undo_last", &approval, ApprovalPayload::default())?;
    agent::snapshot::undo_last()
}

#[tauri::command]
pub fn agent_clear_undo_stack() {
    agent::snapshot::clear();
}
