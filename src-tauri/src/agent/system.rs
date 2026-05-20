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
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let timeout = std::time::Duration::from_secs(APPLESCRIPT_TIMEOUT_SECS);
    let (output, timed_out) = match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(o)) => (o, false),
        Ok(Err(e)) => return Err(err_string(ToolError::io(e.to_string()))),
        Err(_) => return Ok(ShellResult {
            stdout: String::new(),
            stderr: format!("timed out after {APPLESCRIPT_TIMEOUT_SECS}s"),
            exit_code: -1,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out: true,
        }),
    };
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stdout.len() > MAX_SHELL_OUTPUT { stdout.truncate(MAX_SHELL_OUTPUT); stdout.push_str("\n[truncated]"); }
    if stderr.len() > MAX_SHELL_OUTPUT { stderr.truncate(MAX_SHELL_OUTPUT); stderr.push_str("\n[truncated]"); }
    Ok(ShellResult {
        stdout, stderr,
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
        stdin.write_all(text.as_bytes()).await
            .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    }
    let status = child.wait().await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io("pbcopy failed")));
    }
    Ok(())
}

/* ── Open app + notifications ────────────────────────────────────────────── */

pub async fn open_app(name: String) -> Result<(), String> {
    // Validate app name — alphanumeric + space + dot/dash. Block argv injection.
    static APP_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r"^[A-Za-z0-9 ._-]+$").unwrap()
    });
    if name.is_empty() || name.len() > 128 || !APP_RE.is_match(&name) {
        return Err(err_string(ToolError::invalid("app name has illegal characters")));
    }
    let status = tokio::process::Command::new("open")
        .arg("-a").arg(&name)
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
        .arg("-e").arg(&script)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io("osascript failed")));
    }
    Ok(())
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
        .arg("-t").arg("png")
        .arg(&path_str)
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    if !status.success() {
        return Err(err_string(ToolError::io(format!("screencapture exited {status}"))));
    }
    let bytes = tokio::fs::metadata(&target).await
        .map(|m| m.len()).unwrap_or(0);
    Ok(ScreenshotResult { path: path_str, bytes })
}
