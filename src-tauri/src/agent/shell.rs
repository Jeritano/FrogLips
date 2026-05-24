use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;
use tokio::task::AbortHandle;

use super::fs::{err_string, validate_for_read, workspace_root_clone, ToolError, MAX_SHELL_OUTPUT};

/// Default per-command wall-clock budget when the caller doesn't specify one.
/// Tuned for read-only inspection commands (`ls`, `git status`, `cargo
/// check --message-format=short`) that almost always finish under a few
/// seconds. Long-running operations (`cargo test`, `npm install`, model
/// downloads) should pass `opts.timeout_secs` explicitly.
pub(crate) const SHELL_TIMEOUT_DEFAULT_SECS: u64 = 30;
/// Hard ceiling on caller-supplied timeouts so a buggy agent can't wedge an
/// op for hours. Roughly long enough for a fresh `cargo build` from cold,
/// short enough that a hung child is recoverable in one coffee break.
pub(crate) const SHELL_TIMEOUT_MAX_SECS: u64 = 600;

/// Whether an env var name belongs to the dynamic-linker family used to
/// inject code into the child process at exec time (`LD_PRELOAD`,
/// `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, …). Case-insensitive — the
/// macOS and glibc loaders themselves are case-sensitive, but the user-facing
/// approval modal shows the command not the env, so we err loud and refuse
/// any close-match.
pub(crate) fn is_dynlinker_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("LD_") || upper.starts_with("DYLD_")
}

/// Largest char-boundary index <= `max` so `String::truncate` never panics mid-codepoint.
pub(crate) fn safe_truncate_idx(s: &str, max: usize) -> usize {
    let mut idx = max.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/* ── Shell result ────────────────────────────────────────────────────────── */

#[derive(Serialize, Clone)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/* ── Run shell w/ cwd + env + duration + cancellation ────────────────────── */

#[derive(Deserialize)]
pub struct ShellOpts {
    pub cwd: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    /// Per-call wall-clock budget in seconds. Clamped to
    /// `[1, SHELL_TIMEOUT_MAX_SECS]`; `None` falls back to
    /// `SHELL_TIMEOUT_DEFAULT_SECS`.
    pub timeout_secs: Option<u64>,
}

static SHELL_HANDLES: Lazy<Mutex<HashMap<String, AbortHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn cancel_shell(op_id: String) {
    if let Some(h) = SHELL_HANDLES.lock().remove(&op_id) {
        h.abort();
    }
}

pub async fn run_shell(
    command: String,
    opts: Option<ShellOpts>,
    op_id: Option<String>,
) -> Result<ShellResult, String> {
    if command.is_empty() || command.len() > 4096 {
        return Err(err_string(ToolError::invalid("command length invalid")));
    }
    let opts = opts.unwrap_or(ShellOpts {
        cwd: None,
        env: None,
        timeout_secs: None,
    });
    // Resolve the timeout up front so the value baked into both the future and
    // the diagnostic message agree.
    let timeout_secs = opts
        .timeout_secs
        .map(|t| t.clamp(1, SHELL_TIMEOUT_MAX_SECS))
        .unwrap_or(SHELL_TIMEOUT_DEFAULT_SECS);

    // NOTE: only the cwd is path-validated here — the command itself is NOT
    // contained to the workspace and can touch any path the user could.
    let cwd_path: Option<PathBuf> = match opts.cwd.as_ref() {
        Some(c) => Some(validate_for_read(c).map_err(err_string)?),
        None => workspace_root_clone(),
    };
    if let Some(env) = &opts.env {
        for (k, v) in env {
            if k.contains(['\0', '=']) {
                return Err(err_string(ToolError::invalid("invalid env var name")));
            }
            // NUL terminates a C string — the kernel would silently truncate
            // an env value at the first NUL. Reject so the model can't smuggle
            // a hidden suffix past the approval modal.
            if v.contains('\0') {
                return Err(err_string(ToolError::invalid("invalid env var value")));
            }
            // Block dynamic-linker hijacking keys. The approval modal shows the
            // command but NOT the env map, so without this a model can sneak
            // an `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` into an otherwise
            // benign-looking command. No opt-in surface exists today, so a
            // hard deny is the only safe default.
            if is_dynlinker_env_key(k) {
                return Err(err_string(ToolError::invalid(
                    "dynamic-linker env vars are not permitted",
                )));
            }
        }
    }

    let env_pairs = opts.env.clone();
    let cmd_str = command.clone();

    let task = tokio::spawn(async move {
        let started = Instant::now();
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&cmd_str);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(c) = cwd_path {
            cmd.current_dir(c);
        }
        if let Some(env) = env_pairs {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let timeout = std::time::Duration::from_secs(timeout_secs);
        let fut = cmd.output();
        let (output, timed_out) = match tokio::time::timeout(timeout, fut).await {
            Ok(Ok(o)) => (o, false),
            Ok(Err(e)) => {
                return Err::<ShellResult, String>(err_string(ToolError::io(e.to_string())))
            }
            Err(_) => {
                return Ok(ShellResult {
                    stdout: String::new(),
                    stderr: format!("timed out after {timeout_secs}s"),
                    exit_code: -1,
                    duration_ms: started.elapsed().as_millis() as u64,
                    timed_out: true,
                });
            }
        };

        let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if stdout.len() > MAX_SHELL_OUTPUT {
            stdout.truncate(safe_truncate_idx(&stdout, MAX_SHELL_OUTPUT));
            stdout.push_str("\n[truncated]");
        }
        if stderr.len() > MAX_SHELL_OUTPUT {
            stderr.truncate(safe_truncate_idx(&stderr, MAX_SHELL_OUTPUT));
            stderr.push_str("\n[truncated]");
        }
        Ok(ShellResult {
            stdout,
            stderr,
            exit_code: output.status.code().unwrap_or(-1),
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
        })
    });

    if let Some(id) = op_id.as_ref() {
        SHELL_HANDLES.lock().insert(id.clone(), task.abort_handle());
    }

    let join_result = task.await;
    if let Some(id) = op_id.as_ref() {
        SHELL_HANDLES.lock().remove(id);
    }

    match join_result {
        Ok(inner) => inner,
        Err(e) if e.is_cancelled() => Ok(ShellResult {
            stdout: String::new(),
            stderr: "cancelled by user".into(),
            exit_code: -1,
            duration_ms: 0,
            timed_out: false,
        }),
        Err(e) => Err(err_string(ToolError::io(e.to_string()))),
    }
}

/// Read an async reader into a buffer with a hard byte cap so a process
/// emitting an unbounded stream can't buffer all of it in memory before
/// truncation. Returns `(bytes, truncated)`.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    mut r: R,
    cap: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut truncated = false;
    let mut chunk = vec![0u8; 8192];
    loop {
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if buf.len() >= cap {
            truncated = true;
            break;
        }
        let take = n.min(cap - buf.len());
        buf.extend_from_slice(&chunk[..take]);
        if take < n {
            truncated = true;
            break;
        }
    }
    Ok((buf, truncated))
}

/// Run a child to completion, reading stdout and stderr each with a hard
/// byte cap. Returns `(stdout, stderr, exit_code)` where the byte vecs are
/// capped at `cap` (with a "\n[truncated]" marker appended when truncated).
pub(super) async fn capped_output(
    mut cmd: tokio::process::Command,
    cap: usize,
) -> std::io::Result<(Vec<u8>, Vec<u8>, i32)> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut out = Vec::new();
    let mut err = Vec::new();
    if let Some(s) = stdout {
        let (b, t) = read_capped(s, cap).await?;
        out = b;
        if t {
            out.extend_from_slice(b"\n[truncated]");
        }
    }
    if let Some(s) = stderr {
        let (b, t) = read_capped(s, cap).await?;
        err = b;
        if t {
            err.extend_from_slice(b"\n[truncated]");
        }
    }
    let status = child.wait().await?;
    Ok((out, err, status.code().unwrap_or(-1)))
}

/// Heuristic classifier for visibly destructive shell commands. Lets the
/// frontend show an extra-loud confirmation. Not a security boundary on its
/// own — user is still the final gate.
pub fn classify_shell_risk(command: &str) -> &'static str {
    let lc = command.to_lowercase();
    // Code review M8: substring matching missed `rm  -rf  /` (double
    // space) and similar whitespace-bypass cases. Normalize whitespace
    // first so the same logical command always matches.
    let normalized: String = {
        let mut out = String::with_capacity(lc.len());
        let mut last_was_space = false;
        for ch in lc.chars() {
            if ch.is_whitespace() {
                if !last_was_space {
                    out.push(' ');
                }
                last_was_space = true;
            } else {
                out.push(ch);
                last_was_space = false;
            }
        }
        out.trim().to_string()
    };
    let patterns: &[&str] = &[
        "rm -rf /",
        "rm -rf ~",
        "rm -rf --no-preserve-root",
        ":(){:|:&};:",
        "mkfs",
        "dd of=/dev/",
        "shutdown",
        "reboot",
        "halt",
        "diskutil erasedisk",
        "format /",
        "chown -r root",
        "chmod -r 777 /",
        "> /dev/sda",
    ];
    if patterns.iter().any(|p| normalized.contains(p)) {
        return "destructive";
    }
    if normalized.contains("curl ") && normalized.contains("| sh") {
        return "pipe-from-network";
    }
    if normalized.contains("sudo ") || normalized.starts_with("sudo") {
        return "privileged";
    }
    "normal"
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_shell_risk_destructive_patterns() {
        for cmd in [
            "rm -rf /",
            "rm -rf ~",
            "mkfs.ext4 /dev/sda1",
            "dd of=/dev/disk0",
            ":(){:|:&};:",
            "shutdown -h now",
            // M8 whitespace-evasion cases now caught by the normalizer.
            "rm  -rf  /",
            "rm\t-rf /",
            "  rm -rf ~  ",
        ] {
            assert_eq!(classify_shell_risk(cmd), "destructive", "case: {cmd}");
        }
    }

    #[test]
    fn classify_shell_risk_pipe_from_network() {
        for cmd in [
            "curl https://example.com/install.sh | sh",
            "curl -fsSL https://x.com/foo | sh",
        ] {
            assert_eq!(classify_shell_risk(cmd), "pipe-from-network", "case: {cmd}");
        }
    }

    #[test]
    fn classify_shell_risk_privileged() {
        assert_eq!(
            classify_shell_risk("sudo brew install ollama"),
            "privileged"
        );
    }

    #[test]
    fn dynlinker_env_keys_are_rejected() {
        // All of these prefixes inject code at child-exec time.
        for k in [
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
            // Case-insensitive: a lowercase variant still flags. The platform
            // loader is case-sensitive but our modal hides env from the user,
            // so we deny near-matches loudly.
            "ld_preload",
            "Dyld_Insert_Libraries",
        ] {
            assert!(is_dynlinker_env_key(k), "should reject: {k}");
        }
        // Unrelated keys still pass.
        for k in ["PATH", "HOME", "RUST_LOG", "MY_LD", "PRELOAD", "DYLDFOO"] {
            assert!(!is_dynlinker_env_key(k), "should permit: {k}");
        }
    }

    #[test]
    fn classify_shell_risk_normal() {
        for cmd in [
            "ls -la",
            "git status",
            "cargo test",
            "npm install lodash",
            "echo hello world",
        ] {
            assert_eq!(classify_shell_risk(cmd), "normal", "case: {cmd}");
        }
    }
}
