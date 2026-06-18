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
    pub mcp_server: Option<String>,
    pub mcp_tool: Option<String>,
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
        // task_create backgrounds the same `sh -c` execution as
        // agent_run_shell, so it binds to the exact command string too.
        //
        // INVARIANT (sec audit round 2): `ShellOpts.env` is deliberately NOT in
        // the agent tool schema (src/lib/agent-loop/tools.ts) and is invisible
        // to the confirmation modal, so it is intentionally omitted from this
        // binding. If `env` (or a non-validated `cwd`) is ever exposed to the
        // model, it MUST be folded in here (sorted key=value for env) so a
        // minted token can't be swapped to a different environment after the
        // user approves. `cwd` today is re-validated against the read gate at
        // exec time (shell.rs), so a swap can't escape confinement.
        "agent_run_shell" | "task_create" => Some(sha256_hex(&kv(&[(
            "command",
            p.command.as_deref().unwrap_or(""),
        )]))),
        // Code sandbox binds to BOTH language + code so neither can be swapped
        // after approval. Mirrors agent_run_shell's command binding.
        "agent_run_code" => Some(sha256_hex(&kv(&[
            ("language", p.text.as_deref().unwrap_or("")),
            ("code", p.command.as_deref().unwrap_or("")),
        ]))),
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
        // Multi-file write: bound to the EXACT set of paths the user confirmed.
        // The `paths` value is the file paths joined by '\n', sorted — so a
        // token approved for one scaffold can't be reused for a different set
        // of files within the TTL, and caller-side ordering is irrelevant.
        // Reuses the existing `path` payload field to carry that joined string
        // (lowest-churn — no new ApprovalPayload field); the consume side in
        // `agent_write_files` rebuilds the same joined-sorted string.
        "agent_write_files" => Some(sha256_hex(&kv(&[(
            "paths",
            p.path.as_deref().unwrap_or(""),
        )]))),
        // apply_patch binds to the EXACT unified-diff text the user confirmed,
        // carried in the `text` payload field. A swapped patch (even one
        // touching the same files) recomputes a different hash and is rejected.
        "agent_apply_patch" => Some(sha256_hex(&kv(&[(
            "patch",
            p.text.as_deref().unwrap_or(""),
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
        // git commit — bound to message + optional path so an approved commit
        // can't be replayed for a different one within the token TTL. Brings it
        // in line with every other mutating tool's approval model.
        "agent_git_commit" => Some(sha256_hex(&kv(&[
            ("message", p.text.as_deref().unwrap_or("")),
            ("path", p.path.as_deref().unwrap_or("")),
        ]))),
        // Screenshot: bind to a path target so a token issued for
        // "save to ~/Desktop/x.png" can't be reused for a different dest.
        "agent_screenshot" => Some(sha256_hex(&kv(&[(
            "path",
            p.path.as_deref().unwrap_or(""),
        )]))),
        // Computer Use — every desktop-input action binds to a single canonical
        // string carried in `text` (built identically on the TS mint side and
        // the Rust verify side). The tool name is already part of the token, so
        // sharing the `cu` key namespace across actions can't enable cross-tool
        // replay. cu_screenshot takes no args → a fixed marker.
        "agent_cu_screenshot" => Some(sha256_hex(&kv(&[("op", "cu_screenshot")]))),
        "agent_cu_move" | "agent_cu_click" | "agent_cu_drag" | "agent_cu_type" | "agent_cu_key"
        | "agent_cu_scroll" => Some(sha256_hex(&kv(&[("cu", p.text.as_deref().unwrap_or(""))]))),
        // HTTP + browser — URL-bound.
        "agent_http_request" | "agent_web_fetch" | "agent_browser_navigate" => {
            Some(sha256_hex(&kv(&[("url", p.url.as_deref().unwrap_or(""))])))
        }
        // call_api: bind to api id + method + path (the url field carries
        // "<api>|<method>|<path>" from the dispatcher).
        "agent_call_api" => Some(sha256_hex(&kv(&[("call", p.url.as_deref().unwrap_or(""))]))),
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
        // MCP tool call — bound to (server, tool). Args are NOT in the
        // binding: number-format drift between JS `JSON.stringify` and Rust
        // `serde_json::Number::to_string` (e.g. `1.0` vs `1`) makes a
        // canonical-JSON binding silently break in the float case. The
        // user-confirmation modal already shows the exact args at call time;
        // the IPC gate ensures a leaked token for benign tool X cannot be
        // replayed against dangerous tool Y on the same server within the
        // 60s TTL. (Audit C2, 2026-05-26.)
        "mcp_call_tool" => Some(sha256_hex(&kv(&[
            ("server", p.mcp_server.as_deref().unwrap_or("")),
            ("tool", p.mcp_tool.as_deref().unwrap_or("")),
        ]))),
        // Runtime-state-mutating tools that ARE in the frontend DANGEROUS_TOOLS
        // set but previously had no Rust-side binding (audit A08/A25/A38) — a
        // gate that only the renderer enforced. watch_path spawns a persistent
        // OS watcher (bind to the watched path); stop_watch/task_cancel destroy
        // other runtime state by id (bind to that id, carried in `text`).
        "agent_watch_path" => Some(sha256_hex(&kv(&[(
            "path",
            p.path.as_deref().unwrap_or(""),
        )]))),
        "agent_stop_watch" => Some(sha256_hex(&kv(&[(
            "watch_id",
            p.text.as_deref().unwrap_or(""),
        )]))),
        "task_cancel" => Some(sha256_hex(&kv(&[(
            "task_id",
            p.text.as_deref().unwrap_or(""),
        )]))),
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
pub(crate) fn verify_bound(
    tool: &str,
    approval: &str,
    payload: ApprovalPayload,
) -> Result<(), String> {
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
pub async fn agent_run_code(
    language: String,
    code: String,
    timeout_secs: Option<u64>,
    op_id: Option<String>,
    approval: String,
) -> Result<agent::ShellResult, String> {
    // Bound to the exact language + code so a token approved for one snippet
    // can't be reused to run a different one within the TTL. Same containment
    // posture as agent_run_shell (this is arbitrary code execution).
    verify_bound(
        "agent_run_code",
        &approval,
        ApprovalPayload {
            command: Some(code.clone()),
            text: Some(language.clone()),
            ..Default::default()
        },
    )?;
    agent::run_code(language, code, timeout_secs, op_id).await
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

/// Canonical join of a multi-write request's paths: sorted, '\n'-separated.
/// This is the EXACT string both sides of the binding agree on — the frontend
/// mints `mint_tool_approval("agent_write_files", payload.path = join_paths(...))`
/// and this command rebuilds it from the actual `files` argument. Sorting makes
/// the binding independent of the order the model emitted the files in.
fn join_write_files_paths(files: &[agent::WriteFileSpec]) -> String {
    let mut paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    paths.sort_unstable();
    paths.join("\n")
}

#[tauri::command]
pub async fn agent_write_files(
    files: Vec<agent::WriteFileSpec>,
    approval: String,
) -> Result<serde_json::Value, String> {
    // Bound to the EXACT set of paths (sorted, '\n'-joined): a token approved
    // for one scaffold cannot be silently reused to write a different set of
    // files within the 60s TTL. Fail closed — recomputed here from the files
    // we are about to write so the frontend can't approve one set and write
    // another. DANGEROUS: this creates many files in one approval.
    verify_bound(
        "agent_write_files",
        &approval,
        ApprovalPayload {
            path: Some(join_write_files_paths(&files)),
            ..Default::default()
        },
    )?;
    agent::write_files(files).await
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

/// Read-only multi-file read (exp #2). No approval — same gate as
/// `agent_read_file`, applied per file.
#[tauri::command]
pub async fn agent_read_files(paths: Vec<String>) -> Result<serde_json::Value, String> {
    agent::read_files(paths).await
}

#[tauri::command]
pub async fn agent_search_files(
    path: String,
    pattern: String,
    glob: Option<String>,
    regex: Option<bool>,
    context: Option<u32>,
) -> Result<agent::SearchResult, String> {
    agent::search_files(path, pattern, glob, regex, context).await
}

/// Apply a multi-file unified diff atomically (exp #3). Bound to the exact
/// patch text the user confirmed so a swapped diff can't ride the same token.
#[tauri::command]
pub async fn agent_apply_patch(
    patch: String,
    approval: String,
) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_apply_patch",
        &approval,
        ApprovalPayload {
            text: Some(patch.clone()),
            ..Default::default()
        },
    )?;
    agent::apply_patch(patch).await
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
    approval: String,
) -> Result<agent::GitResult, String> {
    verify_bound(
        "agent_git_commit",
        &approval,
        ApprovalPayload {
            text: Some(message.clone()),
            path: path.clone(),
            ..Default::default()
        },
    )?;
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

/* ── Computer Use (gated macOS desktop control) ─────────────────────────────
 *
 * Each cu_* command is bound by `verify_bound` to a canonical string the TS
 * side reproduces verbatim when it mints the token (tauri-api.ts). The bodies
 * cfg-branch: real work on macOS (agent::computer), a clear error elsewhere.
 * Accessibility-permission enforcement lives inside agent::computer (fail
 * closed) so a non-granted call returns guidance instead of a silent no-op. */

/// Read-only: is Froglips trusted for Accessibility? `prompt=true` triggers the
/// macOS "open Accessibility settings" dialog when it is not. No approval — it
/// neither reads screen content nor posts input.
#[tauri::command]
pub fn agent_cu_check_permission(prompt: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::check_permission(prompt))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = prompt;
        Ok(false)
    }
}

#[tauri::command]
pub async fn agent_cu_screenshot(approval: String) -> Result<serde_json::Value, String> {
    verify_bound("agent_cu_screenshot", &approval, ApprovalPayload::default())?;
    #[cfg(target_os = "macos")]
    {
        agent::computer::screenshot().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_move(x: i64, y: i64, approval: String) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_move",
        &approval,
        ApprovalPayload {
            text: Some(format!("{x}|{y}")),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::move_to(x as f64, y as f64))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_click(
    x: i64,
    y: i64,
    button: String,
    count: u32,
    approval: String,
) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_click",
        &approval,
        ApprovalPayload {
            text: Some(format!("{x}|{y}|{button}|{count}")),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::click(x as f64, y as f64, &button, count))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&button, count);
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_drag(
    x1: i64,
    y1: i64,
    x2: i64,
    y2: i64,
    approval: String,
) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_drag",
        &approval,
        ApprovalPayload {
            text: Some(format!("{x1}|{y1}|{x2}|{y2}")),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::drag(
            x1 as f64, y1 as f64, x2 as f64, y2 as f64,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_scroll(
    x: i64,
    y: i64,
    dx: i64,
    dy: i64,
    approval: String,
) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_scroll",
        &approval,
        ApprovalPayload {
            text: Some(format!("{x}|{y}|{dx}|{dy}")),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::scroll(
            x as f64, y as f64, dx as i32, dy as i32,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_type(text: String, approval: String) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_type",
        &approval,
        ApprovalPayload {
            text: Some(text.clone()),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::type_text(&text))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

#[tauri::command]
pub async fn agent_cu_key(keys: String, approval: String) -> Result<serde_json::Value, String> {
    verify_bound(
        "agent_cu_key",
        &approval,
        ApprovalPayload {
            text: Some(keys.clone()),
            ..Default::default()
        },
    )?;
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::key(&keys))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
}

/// Read-only: current cursor location. No approval (observes, never acts).
#[tauri::command]
pub async fn agent_cu_cursor_position() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(agent::computer::cursor_position())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("computer use is macOS-only".into())
    }
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
pub async fn agent_call_api(
    input: agent::CallApiInput,
    approval: String,
) -> Result<agent::HttpResp, String> {
    // Bound to api|method|path — an approval for a GET can't be replayed as a
    // DELETE, nor reused against a different endpoint within the 60s TTL.
    verify_bound(
        "agent_call_api",
        &approval,
        ApprovalPayload {
            url: Some(format!("{}|{}|{}", input.api, input.method, input.path)),
            ..Default::default()
        },
    )?;
    agent::call_api(input).await
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
    approval: String,
) -> Result<agent::fs_watcher::WatchHandle, String> {
    // Path-bound: watch_path spawns a persistent OS filesystem watcher; gate it
    // with a token like every other DANGEROUS tool so the renderer can't start
    // one without the confirmation modal (audit A08).
    verify_bound(
        "agent_watch_path",
        &approval,
        ApprovalPayload {
            path: Some(path.clone()),
            ..Default::default()
        },
    )?;
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
pub fn agent_stop_watch(id: String, approval: String) -> Result<(), String> {
    // Destroys runtime state (a watcher the user set up) by id — bound to that
    // id so the gate isn't renderer-only (audit A25).
    verify_bound(
        "agent_stop_watch",
        &approval,
        ApprovalPayload {
            text: Some(id.clone()),
            ..Default::default()
        },
    )?;
    agent::fs_watcher::stop_watch(id)
}

/* ── Task queue ──────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn task_create(
    command: String,
    cwd: Option<String>,
    approval: String,
) -> Result<task_queue::TaskInfo, String> {
    // SEC-HIGH (2026-05-30): task_create runs the command through `sh -c`
    // exactly like agent_run_shell, so it MUST share the same command-bound
    // approval gate. Without it a prompt-injected model could background-spawn
    // arbitrary shell, bypassing the shell-approval mechanism entirely.
    // Bound to the SHA-256 of the exact command string (same shape as
    // agent_run_shell) so an approval for one command can't run another.
    verify_bound(
        "task_create",
        &approval,
        ApprovalPayload {
            command: Some(command.clone()),
            ..Default::default()
        },
    )?;
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
pub fn task_cancel(id: String, approval: String) -> Result<(), String> {
    // Destroys other runtime state (kills an in-flight background task) by id —
    // bound to that id; sibling task_create is already bound (audit A38).
    verify_bound(
        "task_cancel",
        &approval,
        ApprovalPayload {
            text: Some(id.clone()),
            ..Default::default()
        },
    )?;
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

// Item 6 (default-reach confinement) — migration decision, recorded here next to
// the workspace command so it can't drift from the enforcement:
//
//   * `path = None` (no workspace set) does NOT mean "full filesystem". The
//     authoritative gate `agent::fs::within_workspace` falls back to
//     `default_workspace_root()` = the user's $HOME and confines every read /
//     write / shell cwd to it (Sec review H2). The protected credential/system
//     denylist (~/.ssh, ~/.aws, /etc, …) is ALSO enforced inside $HOME. So the
//     agent's DEFAULT reach is already confined to the home folder; there is no
//     unconfined / whole-disk mode to opt out of, and never was on this build.
//   * Because the safe default is already in force in Rust, no migration is
//     needed: EXISTING users keep the exact same effective reach (home folder,
//     minus the denylist) and FRESH installs get it too. Setting a workspace
//     simply NARROWS the reach to a single project — it is always a tightening,
//     never a loosening, so it can't break an existing user.
//   * The misleading "(full filesystem)" UI copy (which implied a whole-disk
//     default) was corrected to "home folder" in the agent toolbar / settings
//     panel so the surfaced scope matches what this gate actually enforces.

#[tauri::command]
pub fn agent_set_workspace(path: Option<String>) -> Result<Option<String>, String> {
    // Item 3 (interim): reject a divergent workspace change while an agent run is
    // in flight. WORKSPACE_ROOT is process-global, so retargeting it mid-run
    // would silently move a sibling run's sandbox to a different directory.
    // Route the rejection through the health registry so the item-6 "Degraded"
    // pill surfaces it, then return the error (the caller's UI shows it too).
    if let Err(e) = agent::check_workspace_change_allowed(path.as_deref()) {
        crate::health::set("workspace", crate::health::HealthState::Degraded, &e);
        return Err(e);
    }
    let previous = agent::get_workspace_root();
    let result = agent::set_workspace_root(path)?;
    // A successful, allowed change clears any prior workspace degradation.
    crate::health::clear("workspace");
    let _guard = crate::settings::lock_for_update();
    let mut s = crate::settings::load();
    s.workspace_root = result.clone();
    // Code re-review (low/bug): propagate the save error like every other
    // settings writer (settings_set / setup_complete_set). Discarding it left
    // the live agent on the new root while disk still held the old one, so the
    // user's workspace selection silently "forgot itself" on next launch.
    crate::settings::save(&s).map_err(|e| e.to_string())?;
    drop(_guard);
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

/// Item 3: mark an agent run as started. Pins the current workspace root as the
/// shared root for all concurrent runs so `agent_set_workspace` can reject a
/// divergent mid-run change. Returns the number of runs now in flight. The
/// frontend runner brackets each run with begin/end.
#[tauri::command]
pub fn agent_run_begin() -> usize {
    agent::run_begin()
}

/// Item 3: mark an agent run as finished. When the last run ends the pinned root
/// is released. Returns the number of runs still in flight.
#[tauri::command]
pub fn agent_run_end() -> usize {
    agent::run_end()
}

/// Item 3 (robustness): force the in-flight run count back to zero, releasing the
/// pinned workspace root.
///
/// The begin/end bracket is driven from the renderer (`agentRunBegin` /
/// `agentRunEnd`). Those counters are process-global and survive a renderer
/// reload or WKWebView crash, so any path where `run_begin` succeeded but the
/// matching `run_end` never fired (hard reload, window crash, an exception that
/// escaped the JS `finally`, an aborted send before the end call) leaks the
/// count: `ACTIVE_RUNS` stays > 0 and `ACTIVE_RUN_ROOT` stays pinned for the rest
/// of the process lifetime, making `agent_set_workspace` reject EVERY divergent
/// root change (and pin the health pill to Degraded) until the app is restarted.
///
/// This command gives the renderer a recovery hook: it is safe to call on
/// renderer startup (no genuine in-flight run can predate the page that is
/// booting, since runs are bracketed from that same page) to reconcile a leaked
/// count from the previous page lifetime. It drains the counter via the existing
/// `run_end` transition so the 1 → 0 step still clears the pinned root, and
/// returns the number of leaked runs it cleared (0 in the common, balanced case).
#[tauri::command]
pub fn agent_run_reset() -> usize {
    let mut cleared = 0usize;
    // Drain via run_end so the 1 → 0 transition releases ACTIVE_RUN_ROOT.
    // Bounded by the live count; saturates at 0 so a concurrent end can't loop us.
    while agent::active_run_count() > 0 {
        agent::run_end();
        cleared += 1;
    }
    cleared
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
    // SEC-MED F2 (2026-05-30): confine the ingest root to the workspace and
    // refuse protected roots so the agent can't index credential/system dirs
    // (~/.ssh, ~/.aws, the Keychain dir) and exfiltrate them via rag_search.
    // The per-file walk additionally skips protected paths (see rag.rs).
    let confined = agent::confine_ingest_root(std::path::Path::new(&root))?;
    let root = confined.to_string_lossy().into_owned();
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

/// Lazy, on-demand staleness check for one corpus (cheap stat-only mtime/size
/// diff vs ingest time). Kept out of `list_corpora` so the corpus list call
/// never walks the filesystem; the RAG panel calls this per row off the render
/// path. `rag::corpus_stale` self-validates the name and returns `Ok(false)`
/// for unknown/missing-root corpora.
#[tauri::command]
pub async fn rag_corpus_stale(name: String) -> Result<bool, String> {
    blocking(move || rag::corpus_stale(&name)).await
}

/// Rebuild ONLY the sparse (FTS5 bm25) hybrid-search index for one corpus from
/// its already-stored chunks — no file walk, no re-embed. Cheap, idempotent,
/// forward-only path to give a legacy corpus the keyword leg of hybrid
/// retrieval without a full re-ingest. Returns the chunk count re-derived.
#[tauri::command]
pub async fn rag_rebuild_hybrid_index(name: String) -> Result<usize, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > MAX_RAG_NAME_LEN {
        return Err(format!("name length must be 1..={MAX_RAG_NAME_LEN}"));
    }
    blocking(move || rag::rebuild_hybrid_index(&trimmed)).await
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
) -> Result<agent::extras::ProcessList, String> {
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

#[cfg(test)]
mod binding_tests {
    //! Symmetry tests for `binding_for`. Each dangerous tool family that
    //! has an arm in `binding_for` must (a) produce the same SHA-256 for
    //! the same payload across calls, (b) produce a DIFFERENT hash when
    //! any bound field changes, and (c) never silently fall through to
    //! `None` for the arms we've declared.
    //!
    //! A new dangerous tool added to `binding_for` without a matching
    //! entry below will not break anything by itself — but the matching
    //! test in this file will fail to assert non-`None`, which is the
    //! signal to add the row. (Symmetry between mint and consume sides
    //! is checked in `approval::tests`; this file covers the mint side
    //! independently so a refactor that changes `kv` or `sha256_hex`
    //! gets caught before merge.)
    use super::*;

    /// Every tool family that is supposed to have a binding actually
    /// returns `Some(_)` — guards against an accidental `_ => None`
    /// fall-through after a refactor.
    #[test]
    fn declared_tools_all_have_bindings() {
        let p = ApprovalPayload {
            command: Some("ls".into()),
            path: Some("/tmp/x".into()),
            from: Some("/a".into()),
            to: Some("/b".into()),
            url: Some("https://x".into()),
            pid: Some(1),
            signal: Some("TERM".into()),
            text: Some("hi".into()),
            bundle_id: Some("com.x".into()),
            script: Some("say hi".into()),
            title: Some("t".into()),
            body: Some("b".into()),
            mcp_command: Some("/bin/echo".into()),
            mcp_args: Some(vec!["a".into(), "b".into()]),
            mcp_env_keys: Some(vec!["X".into()]),
            mcp_server: Some("srv".into()),
            mcp_tool: Some("tool".into()),
        };
        for t in [
            "agent_run_shell",
            "agent_write_file",
            "agent_write_files",
            "agent_edit_file",
            "agent_multi_edit",
            "agent_make_dir",
            "agent_delete_path",
            "agent_open_path_in_editor",
            "agent_format_code",
            "agent_move_path",
            "agent_copy_path",
            "agent_undo_last",
            "agent_kill_process",
            "agent_clipboard_set",
            "agent_open_app",
            "agent_show_notification",
            "agent_applescript_run",
            "agent_screenshot",
            "agent_cu_screenshot",
            "agent_cu_move",
            "agent_cu_click",
            "agent_cu_drag",
            "agent_cu_scroll",
            "agent_cu_type",
            "agent_cu_key",
            "agent_http_request",
            "agent_web_fetch",
            "agent_browser_navigate",
            "agent_browser_click",
            "agent_browser_fill",
            "agent_browser_get_text",
            "agent_browser_screenshot",
            "agent_browser_close",
            "agent_git_commit",
            "agent_call_api",
            "mcp_start_server",
            "mcp_call_tool",
            // Runtime-state mutators — bindings added in audit A08/A25/A38.
            "agent_watch_path",
            "agent_stop_watch",
            "task_cancel",
        ] {
            assert!(
                binding_for(t, &p).is_some(),
                "tool {t} has no binding — declared but fell through to None"
            );
        }
    }

    /// Two-pass call with identical payloads must produce byte-identical
    /// fingerprints — guards against accidental clock/random in `kv`.
    #[test]
    fn binding_is_deterministic() {
        let p = ApprovalPayload {
            path: Some("/tmp/notes.md".into()),
            ..Default::default()
        };
        let a = binding_for("agent_write_file", &p).unwrap();
        let b = binding_for("agent_write_file", &p).unwrap();
        assert_eq!(a, b);
    }

    /// Changing any bound field invalidates the previous binding.
    #[test]
    fn path_binding_changes_with_path() {
        let p1 = ApprovalPayload {
            path: Some("/tmp/notes.md".into()),
            ..Default::default()
        };
        let p2 = ApprovalPayload {
            path: Some("/tmp/other.md".into()),
            ..Default::default()
        };
        assert_ne!(
            binding_for("agent_write_file", &p1).unwrap(),
            binding_for("agent_write_file", &p2).unwrap()
        );
    }

    /// `agent_write_files` binds to the SET of paths, sorted, '\n'-joined.
    /// The join helper must make the binding independent of the order the
    /// files were emitted in, and any change to the set must change the hash.
    #[test]
    fn write_files_binding_is_set_based_and_order_invariant() {
        let spec = |p: &str| agent::WriteFileSpec {
            path: p.into(),
            content: String::new(),
        };
        // join_write_files_paths sorts, so order of input is irrelevant.
        assert_eq!(
            join_write_files_paths(&[spec("src/b.rs"), spec("src/a.rs")]),
            join_write_files_paths(&[spec("src/a.rs"), spec("src/b.rs")]),
            "join must be order-invariant",
        );
        // A token approved for {a} must not verify for {a, b}.
        let one = ApprovalPayload {
            path: Some(join_write_files_paths(&[spec("src/a.rs")])),
            ..Default::default()
        };
        let two = ApprovalPayload {
            path: Some(join_write_files_paths(&[
                spec("src/a.rs"),
                spec("src/b.rs"),
            ])),
            ..Default::default()
        };
        assert_ne!(
            binding_for("agent_write_files", &one).unwrap(),
            binding_for("agent_write_files", &two).unwrap()
        );
    }

    /// Shell binding follows `command`, NOT the unrelated `path` field —
    /// a refactor that accidentally cross-wires would be caught here.
    #[test]
    fn shell_binding_follows_command_only() {
        let p_cmd_only = ApprovalPayload {
            command: Some("ls".into()),
            ..Default::default()
        };
        let p_cmd_and_path = ApprovalPayload {
            command: Some("ls".into()),
            path: Some("/tmp".into()),
            ..Default::default()
        };
        assert_eq!(
            binding_for("agent_run_shell", &p_cmd_only).unwrap(),
            binding_for("agent_run_shell", &p_cmd_and_path).unwrap()
        );
        let p_diff_cmd = ApprovalPayload {
            command: Some("rm -rf /".into()),
            ..Default::default()
        };
        assert_ne!(
            binding_for("agent_run_shell", &p_cmd_only).unwrap(),
            binding_for("agent_run_shell", &p_diff_cmd).unwrap()
        );
    }

    /// MCP env_keys are sorted on both sides; the binding must be
    /// invariant under input key order. Infra audit H1 regression test.
    #[test]
    fn mcp_env_keys_order_invariant() {
        let p_abc = ApprovalPayload {
            mcp_command: Some("/usr/local/bin/server".into()),
            mcp_args: Some(vec!["--port".into(), "9000".into()]),
            mcp_env_keys: Some(vec!["A".into(), "B".into(), "C".into()]),
            ..Default::default()
        };
        let p_cba = ApprovalPayload {
            mcp_command: Some("/usr/local/bin/server".into()),
            mcp_args: Some(vec!["--port".into(), "9000".into()]),
            mcp_env_keys: Some(vec!["C".into(), "B".into(), "A".into()]),
            ..Default::default()
        };
        assert_eq!(
            binding_for("mcp_start_server", &p_abc).unwrap(),
            binding_for("mcp_start_server", &p_cba).unwrap()
        );
    }

    /// MCP args are positional — order matters because argv is
    /// semantically ordered. Swapping `--port 9000` to `9000 --port`
    /// must NOT match.
    #[test]
    fn mcp_args_are_position_sensitive() {
        let p1 = ApprovalPayload {
            mcp_command: Some("/x".into()),
            mcp_args: Some(vec!["--port".into(), "9000".into()]),
            ..Default::default()
        };
        let p2 = ApprovalPayload {
            mcp_command: Some("/x".into()),
            mcp_args: Some(vec!["9000".into(), "--port".into()]),
            ..Default::default()
        };
        assert_ne!(
            binding_for("mcp_start_server", &p1).unwrap(),
            binding_for("mcp_start_server", &p2).unwrap()
        );
    }

    /// mcp_call_tool binding follows (server, tool). Swapping either
    /// field invalidates the token; args are intentionally NOT in the
    /// binding (see binding_for comment for the float-format rationale).
    #[test]
    fn mcp_call_tool_binding_follows_server_and_tool() {
        let p_fs_read = ApprovalPayload {
            mcp_server: Some("fs".into()),
            mcp_tool: Some("read_file".into()),
            ..Default::default()
        };
        let p_fs_delete = ApprovalPayload {
            mcp_server: Some("fs".into()),
            mcp_tool: Some("delete_file".into()),
            ..Default::default()
        };
        let p_net_read = ApprovalPayload {
            mcp_server: Some("net".into()),
            mcp_tool: Some("read_file".into()),
            ..Default::default()
        };
        let a = binding_for("mcp_call_tool", &p_fs_read).unwrap();
        let b = binding_for("mcp_call_tool", &p_fs_delete).unwrap();
        let c = binding_for("mcp_call_tool", &p_net_read).unwrap();
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    /// Notification binding uses both title AND body. Re-review M-NEW-1
    /// regression: previously these were concatenated with `\x1f`, which
    /// allowed title="A\x1fB" + body="" to collide with title="A" +
    /// body="B". `kv()` length-prefixes each field, so this should now
    /// fail to collide.
    #[test]
    fn notification_title_body_are_unambiguous() {
        let p_collision_attempt = ApprovalPayload {
            title: Some("A\u{1f}B".into()),
            body: Some(String::new()),
            ..Default::default()
        };
        let p_legitimate = ApprovalPayload {
            title: Some("A".into()),
            body: Some("B".into()),
            ..Default::default()
        };
        assert_ne!(
            binding_for("agent_show_notification", &p_collision_attempt).unwrap(),
            binding_for("agent_show_notification", &p_legitimate).unwrap()
        );
    }

    /// Unknown tools return None — guard against a typo silently turning
    /// a binding-required tool into an unbound `approval::mint` call.
    #[test]
    fn unknown_tool_returns_none() {
        let p = ApprovalPayload::default();
        assert!(binding_for("agent_definitely_not_a_real_tool", &p).is_none());
        assert!(binding_for("", &p).is_none());
    }
}
