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
    let mut cmd = tokio::process::Command::new("osascript");
    cmd.arg("-e").arg(&script);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let timeout = std::time::Duration::from_secs(APPLESCRIPT_TIMEOUT_SECS);
    let (output, timed_out) = match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(o)) => (o, false),
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
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stdout.len() > MAX_SHELL_OUTPUT {
        stdout.truncate(MAX_SHELL_OUTPUT);
        stdout.push_str("\n[truncated]");
    }
    if stderr.len() > MAX_SHELL_OUTPUT {
        stderr.truncate(MAX_SHELL_OUTPUT);
        stderr.push_str("\n[truncated]");
    }
    Ok(ShellResult {
        stdout,
        stderr,
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

/// Risk heuristic for AppleScript payloads. Mirrors `classify_shell_risk`.
pub fn classify_applescript_risk(script: &str) -> &'static str {
    let lc = script.to_lowercase();
    // Shell escape inside AppleScript ⇒ apply the same shell heuristic.
    if lc.contains("do shell script") {
        // Extract the quoted argument and feed it to classify_shell_risk —
        // best-effort, just grab between the first pair of double quotes
        // after the keyword.
        if let Some(start) = lc.find("do shell script") {
            let tail = &script[start..];
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
            return "privileged";
        }
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
    let output = tokio::process::Command::new("pbpaste")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !output.status.success() {
        return Err(err_string(ToolError::io("pbpaste failed")));
    }
    let mut s = String::from_utf8_lossy(&output.stdout).into_owned();
    if s.len() > MAX_READ_BYTES {
        s.truncate(MAX_READ_BYTES);
        s.push_str("\n[clipboard truncated]");
    }
    Ok(s)
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
    // Both fields go into osascript via a `-e` arg. Three rules to keep the
    // model from escaping the string literal:
    //  - swap " for ' (closing the title/body string literal early)
    //  - swap \ for / (backslash escape sequences in AppleScript strings)
    //  - swap any C0 control character (newline, CR, tab, etc.) for a single
    //    space. A literal newline inside a quoted string truncates the
    //    AppleScript line and lets the model append additional statements.
    fn sanitize(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                '"' => '\'',
                '\\' => '/',
                c if (c as u32) < 0x20 || c as u32 == 0x7F => ' ',
                c => c,
            })
            .collect()
    }
    let safe_title = sanitize(&title);
    let safe_body = sanitize(&body);
    if safe_title.len() + safe_body.len() > 4096 {
        return Err(err_string(ToolError::invalid("notification text too long")));
    }
    let script = format!(
        r#"display notification "{}" with title "{}""#,
        safe_body, safe_title
    );
    let status = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
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
    // User's home wins — that's where source code lives.
    if let Some(home) = dirs::home_dir() {
        if let Ok(home_c) = std::fs::canonicalize(&home) {
            if canon.starts_with(&home_c) {
                return true;
            }
        }
    }
    // A handful of conventional scratch / mount points. /tmp and /private/tmp
    // both appear because macOS resolves /tmp → /private/tmp via symlink.
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

pub async fn screenshot(out_path: Option<String>) -> Result<ScreenshotResult, String> {
    // Default destination: app temp dir under the workspace, or /tmp.
    let target = match out_path {
        Some(p) => validate_for_write(&p).map_err(err_string)?,
        None => {
            let dir = std::env::temp_dir();
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
