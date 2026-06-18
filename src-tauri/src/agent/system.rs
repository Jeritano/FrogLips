use serde::Serialize;
use std::process::Stdio;
use std::time::Instant;

use super::fs::{
    err_string, validate_for_write, ToolError, MAX_READ_BYTES, MAX_SHELL_OUTPUT, MAX_WRITE_BYTES,
};
use super::shell::{classify_shell_risk, ShellResult};

/* ── applescript_run ─────────────────────────────────────────────────────── */

const APPLESCRIPT_TIMEOUT_SECS: u64 = 30;
const APPLESCRIPT_MAX_SCRIPT_BYTES: usize = 16_384;

pub async fn applescript_run(script: String) -> Result<ShellResult, String> {
    if script.is_empty() || script.len() > APPLESCRIPT_MAX_SCRIPT_BYTES {
        return Err(err_string(ToolError::invalid("script length invalid")));
    }
    let started = Instant::now();
    // Cage osascript exactly like run_shell (sec review 2026-06 HIGH): wrap it in
    // the same Seatbelt credential-deny profile via `base_command` so an embedded
    // `do shell script` INHERITS the cage (can't read ~/.ssh, Keychains, cookies)
    // instead of escaping it, and strip secrets from the child env via
    // `harden_env`. Previously osascript ran completely uncaged — a strictly more
    // powerful exec primitive than the sandboxed run_shell.
    let mut cmd = super::shell::base_command(&["osascript", "-e", script.as_str()]);
    super::shell::harden_env(&mut cmd, None);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let timeout = std::time::Duration::from_secs(APPLESCRIPT_TIMEOUT_SECS);
    // capped_output bounds stdout/stderr buffering (concurrent drain + hard cap)
    // so an osascript spewing unbounded output can't OOM the app. `harden=true`
    // also puts it in its own process group so a backgrounded `do shell script &`
    // is reaped on timeout.
    let (out, err, exit_code) = match tokio::time::timeout(
        timeout,
        super::shell::capped_output(cmd, MAX_SHELL_OUTPUT, true),
    )
    .await
    {
        Ok(Ok(triple)) => triple,
        Ok(Err(e)) => return Err(err_string(ToolError::io(e.to_string()))),
        Err(_) => {
            return Ok(ShellResult {
                stdout: String::new(),
                stderr: format!("timed out after {APPLESCRIPT_TIMEOUT_SECS}s"),
                exit_code: -1,
                duration_ms: started.elapsed().as_millis() as u64,
                timed_out: true,
            })
        }
    };
    // Review 2026-06 (medium/security): osascript output is at least as
    // untrusted as run_shell/clipboard output — AppleScript can read Mail,
    // Messages, Safari page contents, the clipboard, etc. Fence both channels
    // through the injection scanner before they re-enter the agent loop, exactly
    // as run_shell (shell.rs `fence_output`) and clipboard_get do.
    let stdout = super::injection_scan::scan_and_wrap(&String::from_utf8_lossy(&out)).0;
    let stderr = super::injection_scan::scan_and_wrap(&String::from_utf8_lossy(&err)).0;
    Ok(ShellResult {
        stdout,
        stderr,
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: false,
    })
}

/// Risk heuristic for AppleScript payloads. Mirrors `classify_shell_risk`.
pub fn classify_applescript_risk(script: &str) -> &'static str {
    let lc = script.to_lowercase();
    // Shell escape inside AppleScript ⇒ apply the same shell heuristic.
    if lc.contains("do shell script") {
        // Scan every `do shell script` occurrence — a script can chain
        // several, and a later one could be the destructive one.
        let mut search_from = 0;
        while let Some(rel) = lc[search_from..].find("do shell script") {
            let start = search_from + rel;
            // Index `lc` (the lowercased string) here, NOT `script`: `start` is
            // a byte offset into `lc`, and some chars change byte length when
            // lowercased (Turkish 'İ', …), so slicing the original-case
            // `script` by an `lc` offset can land mid-codepoint and panic. The
            // shell-keyword risk heuristic is case-insensitive, so lowercase is
            // fine here. MED (2026-05-30).
            let tail = &lc[start..];
            if let Some(q1) = tail.find('"') {
                let after = &tail[q1 + 1..];
                if let Some(q2) = after.find('"') {
                    let inner = &after[..q2];
                    let sub = classify_shell_risk(inner);
                    if sub != "normal" {
                        return sub;
                    }
                }
            }
            search_from = start + "do shell script".len();
        }
        return "privileged";
    }
    let destructive: &[&str] = &[
        "tell application \"finder\" to delete",
        "empty trash",
        "tell application \"system events\" to shut down",
        "tell application \"system events\" to restart",
        "tell application \"system events\" to log out",
        "mount volume",
    ];
    if destructive.iter().any(|p| lc.contains(p)) {
        return "destructive";
    }
    if lc.contains("system events") && (lc.contains("keystroke") || lc.contains("click")) {
        return "privileged"; // synthetic input — can drive arbitrary UI
    }
    if lc.contains("with administrator privileges") {
        return "privileged";
    }
    "normal"
}

/* ── Clipboard ───────────────────────────────────────────────────────────── */

pub async fn clipboard_get() -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("pbpaste");
    cmd.kill_on_drop(true);
    // capped_output bounds stdout buffering — clipboard contents are unbounded.
    let (out, _err, code) = super::shell::capped_output(cmd, MAX_READ_BYTES, false)
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if code != 0 {
        return Err(err_string(ToolError::io("pbpaste failed")));
    }
    // Clipboard contents are attacker-controllable — scan for prompt-injection
    // patterns and wrap with a DATA-only marker before the agent ingests them.
    let text = String::from_utf8_lossy(&out).into_owned();
    let (text, _n) = super::injection_scan::scan_and_wrap(&text);
    Ok(text)
}

pub async fn clipboard_set(text: String) -> Result<(), String> {
    if text.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("clipboard text exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("pbcopy")
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io("pbcopy failed")));
    }
    Ok(())
}

/* ── Open app + notifications ────────────────────────────────────────────── */

pub async fn open_app(name: String) -> Result<(), String> {
    // Validate app name — alphanumeric + space + dot/dash. Block argv injection.
    static APP_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"^[A-Za-z0-9 ._-]+$").unwrap());
    if name.is_empty() || name.len() > 128 || !APP_RE.is_match(&name) {
        return Err(err_string(ToolError::invalid(
            "app name has illegal characters",
        )));
    }
    let status = tokio::process::Command::new("open")
        .arg("-a")
        .arg(&name)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io(format!("open -a {name} failed"))));
    }
    Ok(())
}

pub async fn show_notification(title: String, body: String) -> Result<(), String> {
    // Parameterize via environment variables rather than interpolating user
    // input into the AppleScript source. AppleScript's `system attribute`
    // reads an env var verbatim — quotes, newlines, unicode look-alikes, and
    // backslashes inside the value are inert because they never touch the
    // script's tokenizer. The script source itself is a constant string,
    // so there is no way for the model to break out of the string literal
    // (the old approach swapped `"` → `'`, but a unicode close-quote, NEL,
    // or `\n` could still terminate or extend the line).
    if title.len() > 2048 || body.len() > 2048 {
        return Err(err_string(ToolError::invalid("notification text too long")));
    }
    // Reject NULs outright — env vars can't contain them and the spawn
    // would error in a less-clear way otherwise.
    if title.contains('\0') || body.contains('\0') {
        return Err(err_string(ToolError::invalid(
            "notification text may not contain NUL",
        )));
    }
    const SCRIPT: &str = r#"
        set t to (system attribute "FROGLIPS_NOTIF_TITLE")
        set b to (system attribute "FROGLIPS_NOTIF_BODY")
        display notification b with title t
    "#;
    let status = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(SCRIPT)
        .env("FROGLIPS_NOTIF_TITLE", &title)
        .env("FROGLIPS_NOTIF_BODY", &body)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io("osascript failed")));
    }
    Ok(())
}

/* ── Open path in editor ─────────────────────────────────────────────────── */

/// Open `path` (optionally jumping to `line`) in the user's editor.
///
/// Detection ladder:
///   1. `code --goto <path>:<line>` (VS Code on PATH)
///   2. `cursor --goto <path>:<line>` (Cursor on PATH)
///   3. `open <path>` (macOS default app)
///
/// Returns the program that actually ran (`"code"`, `"cursor"`, or `"open"`).
///
/// Safety:
///   * `path` must be absolute or `~/...` — relative paths are rejected so
///     citation clicks can never be coerced into resolving against the app's
///     cwd (which could differ from where the user thinks the file lives).
///   * The path must canonicalize to an existing file or directory.
///   * The canonical path must stay under the user's home dir, or under a
///     few well-known shared roots (`/tmp`, `/private/tmp`, `/Volumes`).
///     Defends against a malicious model surfacing `/etc/passwd:1` and the
///     user clicking it open in their editor — VS Code itself is harmless,
///     but the behavior is still better confined to writable locations.
pub async fn open_path_in_editor(path: String, line: Option<u32>) -> Result<String, String> {
    if path.is_empty() || path.len() > super::fs::MAX_PATH_LEN {
        return Err(err_string(ToolError::invalid("path length invalid")));
    }
    if !(path.starts_with('/') || path.starts_with("~/") || path == "~") {
        return Err(err_string(ToolError::invalid(
            "path must be absolute or start with ~/",
        )));
    }
    // Resolve + canonicalize. `resolve_path(_, true)` rejects `..` and
    // surfaces NotFound errors for nonexistent targets.
    let resolved = super::fs::resolve_path(&path, true)
        .map_err(|e| err_string(ToolError::invalid(e.to_string())))?;
    if !is_open_target_allowed(&resolved) {
        return Err(err_string(ToolError::Protected {
            message: "path is outside user-writable areas".into(),
        }));
    }
    let path_str = resolved.to_string_lossy().into_owned();
    let goto_arg = match line {
        Some(n) if n > 0 => format!("{path_str}:{n}"),
        _ => path_str.clone(),
    };

    // Try VS Code, then Cursor, then fall back to `open`. We probe by
    // attempting to run the editor with `--goto` directly; if the binary
    // isn't on PATH the spawn errors with NotFound and we move on. This
    // avoids a separate `which` round-trip and keeps the happy path one
    // process spawn.
    for prog in ["code", "cursor"] {
        match tokio::process::Command::new(prog)
            .arg("--goto")
            .arg(&goto_arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status()
            .await
        {
            Ok(s) if s.success() => return Ok(prog.to_string()),
            // Binary not on PATH — try the next one. Any other error
            // (non-zero exit, IO error mid-run) is logged via Err so the
            // user can tell the editor was found but failed.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(s) => {
                return Err(err_string(ToolError::io(format!("{prog} exited {s}"))));
            }
            Err(e) => {
                return Err(err_string(ToolError::io(format!("{prog} failed: {e}"))));
            }
        }
    }
    // Fallback: hand off to the OS default app via `open` (macOS).
    let status = tokio::process::Command::new("open")
        .arg(&path_str)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io(format!("open exited {status}"))));
    }
    Ok("open".to_string())
}

/// Whitelist of roots an editor-open is allowed to target. Anything outside
/// these prefixes (e.g. `/etc`, `/System`) is rejected.
fn is_open_target_allowed(canon: &std::path::Path) -> bool {
    // Never open a protected / credential / system file. Sec audit round 3:
    // a workspace-internal symlink can canonicalize into `~/.ssh` etc., which
    // `within_workspace` alone would still accept under the default ($HOME)
    // workspace — so consult the (case-insensitive) read gate first.
    if super::fs::is_protected_read_path(canon) {
        return false;
    }
    // Confine to the agent workspace (defaults to $HOME). Sec audit round 3:
    // previously this allowed ALL of $HOME regardless of the configured
    // workspace, so a narrower project scope didn't apply to editor-open.
    if super::fs::within_workspace(canon) {
        return true;
    }
    // A handful of conventional scratch / mount points outside the workspace.
    // /tmp and /private/tmp both appear because macOS resolves /tmp →
    // /private/tmp via symlink.
    for root in ["/tmp", "/private/tmp", "/Volumes"] {
        if canon.starts_with(root) {
            return true;
        }
    }
    false
}

/* ── Screenshot ──────────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct ScreenshotResult {
    pub path: String,
    pub bytes: u64,
}

/// Delete `froglips-screenshot-*.png` files in `dir` older than one hour so
/// repeated default-destination screenshots don't accumulate in the temp dir
/// indefinitely. Best-effort: any IO error is ignored.
async fn gc_old_screenshots(dir: &std::path::Path) {
    let max_age = std::time::Duration::from_secs(3600);
    let now = std::time::SystemTime::now();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("froglips-screenshot-") && name.ends_with(".png")) {
            continue;
        }
        if let Ok(meta) = entry.metadata().await {
            if let Ok(modified) = meta.modified() {
                if now
                    .duration_since(modified)
                    .map(|a| a > max_age)
                    .unwrap_or(false)
                {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
    }
}

pub async fn screenshot(out_path: Option<String>) -> Result<ScreenshotResult, String> {
    // Default destination: app temp dir under the workspace, or /tmp.
    let target = match out_path {
        Some(p) => validate_for_write(&p).map_err(err_string)?,
        None => {
            let dir = std::env::temp_dir();
            // GC stale screenshots before writing a fresh one.
            gc_old_screenshots(&dir).await;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            dir.join(format!("froglips-screenshot-{stamp}.png"))
        }
    };

    // screencapture: -x silent, -t png. No -i (interactive) so it can't hang.
    let path_str = target.to_string_lossy().into_owned();
    let status = tokio::process::Command::new("screencapture")
        .arg("-x")
        .arg("-t")
        .arg("png")
        .arg(&path_str)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io(format!(
            "screencapture exited {status}"
        ))));
    }
    let bytes = tokio::fs::metadata(&target)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(ScreenshotResult {
        path: path_str,
        bytes,
    })
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_risk_handles_lowercase_byte_length_change() {
        // 'İ' (U+0130) lowercases to 2 chars, shifting byte offsets between the
        // original and the lowercased string. A char like this before
        // "do shell script" must not panic the byte-slice. (regression)
        let script = "-- İ İ İ comment\ndo shell script \"rm -rf /tmp/x\"";
        // Must not panic, and the destructive shell inside is still flagged.
        assert_ne!(classify_applescript_risk(script), "normal");
        // Benign do-shell-script still classifies without panicking.
        let _ = classify_applescript_risk("İ\ndo shell script \"echo hi\"");
    }

    #[tokio::test]
    async fn open_path_rejects_relative() {
        let err = open_path_in_editor("relative/file.rs".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    #[tokio::test]
    async fn open_path_rejects_parent_traversal() {
        let err = open_path_in_editor("/tmp/../etc/passwd".into(), None)
            .await
            .unwrap_err();
        // Either the `..` check trips inside resolve_path, or the resulting
        // canonical path falls outside the allowlist — both are acceptable.
        assert!(
            err.contains("..")
                || err.contains("outside")
                || err.contains("restricted")
                || err.contains("not accessible"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn open_path_rejects_nonexistent() {
        let err = open_path_in_editor("/tmp/__froglips_does_not_exist_xyzzy_9999".into(), None)
            .await
            .unwrap_err();
        assert!(
            err.contains("not accessible") || err.contains("No such"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn open_path_rejects_system_dir() {
        // `/etc` exists and canonicalizes, but lives outside the allowlist.
        let err = open_path_in_editor("/etc/hosts".into(), None)
            .await
            .unwrap_err();
        assert!(
            err.contains("outside") || err.contains("restricted"),
            "got: {err}"
        );
    }

    #[test]
    fn is_open_target_allowed_home_and_tmp() {
        let home = dirs::home_dir().unwrap();
        let in_home = home.join("Documents");
        if in_home.exists() {
            let canon = std::fs::canonicalize(&in_home).unwrap();
            assert!(is_open_target_allowed(&canon));
        }
        assert!(is_open_target_allowed(std::path::Path::new("/tmp/foo")));
        assert!(is_open_target_allowed(std::path::Path::new(
            "/private/tmp/foo"
        )));
        assert!(!is_open_target_allowed(std::path::Path::new("/etc/passwd")));
        assert!(!is_open_target_allowed(std::path::Path::new(
            "/System/Library"
        )));
    }
}
