//! llmpm integration — drive the `llmpm` CLI (an LLM package manager that
//! installs HuggingFace models and serves them over an OpenAI-compatible HTTP
//! API). Froglips uses it as a model SOURCE: install + serve a model, then
//! talk to its `http://localhost:<port>/v1` endpoint through the existing
//! custom-backend chat path (loopback is allowed by the SSRF guard).
//!
//! Design notes:
//!   * We never parse llmpm's rich CLI tables. Installed models are read from
//!     the `~/.llmpm/models/<org>/<name>/` directory tree, and a running
//!     server's model list comes from its own `/v1/models` JSON.
//!   * Exactly one `llmpm serve` child is managed at a time (single port).
//!   * Binary discovery: `LLMPM_BIN` env → PATH (`which`) → common venv/user
//!     locations. Configurable later via settings if needed.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tokio::process::Command;

/// Default port for the managed `llmpm serve` process. 8080 is llmpm's own
/// default; we pick a less-common one to avoid clashing with other dev servers.
const LLMPM_PORT: u16 = 8123;
const LLMPM_HOST: &str = "localhost";

/// One managed `llmpm serve` child + what it's serving.
#[derive(Default)]
pub struct LlmpmState {
    inner: Mutex<Option<ServeProc>>,
}

struct ServeProc {
    child: tokio::process::Child,
    repo: String,
    port: u16,
}

#[derive(Serialize)]
pub struct LlmpmAvailability {
    pub available: bool,
    pub bin: Option<String>,
}

#[derive(Serialize)]
pub struct LlmpmModel {
    pub repo: String,
    /// "gguf" | "transformers" | "unknown" — inferred from the on-disk files.
    pub backend: String,
}

#[derive(Serialize)]
pub struct LlmpmServeStatus {
    pub serving: bool,
    pub repo: Option<String>,
    pub port: Option<u16>,
    /// `http://localhost:<port>/v1` when serving — the base_url to register as
    /// a custom backend.
    pub base_url: Option<String>,
}

/// Resolve the `llmpm` executable. Order: `LLMPM_BIN` env, then PATH, then a
/// few common install locations (pipx / user-base / project venvs).
fn llmpm_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("LLMPM_BIN") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // PATH lookup via `which`-style scan of $PATH.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("llmpm");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    // Common fallbacks.
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin/llmpm", ".llmpm/venv/bin/llmpm"] {
            let cand = home.join(rel);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// `~/.llmpm/models` — where llmpm stores installed models, one dir per repo.
fn llmpm_models_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".llmpm").join("models"))
}

#[tauri::command]
pub fn llmpm_available() -> LlmpmAvailability {
    match llmpm_bin() {
        Some(p) => LlmpmAvailability {
            available: true,
            bin: Some(p.display().to_string()),
        },
        None => LlmpmAvailability {
            available: false,
            bin: None,
        },
    }
}

/// List installed models by scanning `~/.llmpm/models/<org>/<name>/`. Robust
/// against the CLI's un-parseable output. Backend is inferred from whether a
/// `.gguf` file is present in the model dir.
#[tauri::command]
pub fn llmpm_installed_models() -> Result<Vec<LlmpmModel>, String> {
    let root = llmpm_models_dir().ok_or("cannot resolve home directory")?;
    let mut out = Vec::new();
    let orgs = match std::fs::read_dir(&root) {
        Ok(r) => r,
        // Not installed yet / no models dir → empty list, not an error.
        Err(_) => return Ok(out),
    };
    for org in orgs.flatten() {
        if !org.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let org_name = org.file_name().to_string_lossy().to_string();
        let Ok(names) = std::fs::read_dir(org.path()) else {
            continue;
        };
        for name in names.flatten() {
            if !name.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let model_name = name.file_name().to_string_lossy().to_string();
            let backend = infer_backend(&name.path());
            out.push(LlmpmModel {
                repo: format!("{org_name}/{model_name}"),
                backend,
            });
        }
    }
    out.sort_by(|a, b| a.repo.cmp(&b.repo));
    Ok(out)
}

fn infer_backend(dir: &std::path::Path) -> String {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let n = e.file_name();
            let n = n.to_string_lossy();
            if n.ends_with(".gguf") {
                return "gguf".to_string();
            }
            if n == "config.json" || n.ends_with(".safetensors") {
                return "transformers".to_string();
            }
        }
    }
    "unknown".to_string()
}

/// Install a model via `llmpm install <repo> [--quant <q>]`. Streams stdout/
/// stderr lines as `llmpm-install-progress` events; resolves when the process
/// exits. `quant` (GGUF only) makes the install non-interactive.
#[tauri::command]
pub async fn llmpm_install(
    repo: String,
    quant: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    validate_repo(&repo)?;
    let bin = llmpm_bin().ok_or("llmpm not found on PATH (install: pip install llmpm)")?;
    let mut cmd = Command::new(&bin);
    cmd.arg("install").arg(&repo);
    if let Some(q) = quant.as_deref() {
        validate_quant(q)?;
        cmd.arg("--quant").arg(q);
    }
    cmd.env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn llmpm install: {e}"))?;

    // Drain both pipes, emitting trimmed lines as progress.
    use tokio::io::{AsyncBufReadExt, BufReader};
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let repo = repo.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "llmpm-install-progress",
                    serde_json::json!({ "repo": repo, "line": clean_progress_line(&line) }),
                );
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let repo = repo.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "llmpm-install-progress",
                    serde_json::json!({ "repo": repo, "line": clean_progress_line(&line) }),
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("llmpm install failed: {e}"))?;
    if !status.success() {
        return Err(format!(
            "llmpm install exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Serve a model: spawn `llmpm serve <repo> --port <p> --host localhost`,
/// store the child, and poll `/v1/models` until it answers (or time out).
/// Returns the base_url to register as a custom backend.
#[tauri::command]
pub async fn llmpm_serve(
    repo: String,
    state: tauri::State<'_, LlmpmState>,
) -> Result<LlmpmServeStatus, String> {
    validate_repo(&repo)?;
    let bin = llmpm_bin().ok_or("llmpm not found on PATH")?;

    // Stop any existing serve first (single-port model).
    stop_inner(&state);

    let port = LLMPM_PORT;
    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .arg(&repo)
        .arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg(LLMPM_HOST)
        .env("NO_COLOR", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Reap the child when its handle drops (stop / app-exit teardown).
        // `kill_on_drop` is cross-platform in tokio — no cfg gate.
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn llmpm serve: {e}"))?;

    {
        let mut guard = state.inner.lock().map_err(|_| "llmpm state poisoned")?;
        *guard = Some(ServeProc {
            child,
            repo: repo.clone(),
            port,
        });
    }

    // Readiness probe — model load can take tens of seconds.
    let base_url = format!("http://{LLMPM_HOST}:{port}/v1");
    let probe = format!("{base_url}/models");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..60 {
        if client
            .get(&probe)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    if !ready {
        stop_inner(&state);
        return Err(format!(
            "llmpm serve started but {probe} did not become ready within ~120s"
        ));
    }

    Ok(LlmpmServeStatus {
        serving: true,
        repo: Some(repo),
        port: Some(port),
        base_url: Some(base_url),
    })
}

#[tauri::command]
pub fn llmpm_stop(state: tauri::State<'_, LlmpmState>) -> Result<(), String> {
    stop_inner(&state);
    Ok(())
}

#[tauri::command]
pub fn llmpm_serve_status(state: tauri::State<'_, LlmpmState>) -> LlmpmServeStatus {
    let guard = match state.inner.lock() {
        Ok(g) => g,
        Err(_) => {
            return LlmpmServeStatus {
                serving: false,
                repo: None,
                port: None,
                base_url: None,
            }
        }
    };
    match guard.as_ref() {
        Some(p) => LlmpmServeStatus {
            serving: true,
            repo: Some(p.repo.clone()),
            port: Some(p.port),
            base_url: Some(format!("http://{LLMPM_HOST}:{}/v1", p.port)),
        },
        None => LlmpmServeStatus {
            serving: false,
            repo: None,
            port: None,
            base_url: None,
        },
    }
}

pub(crate) fn stop_inner(state: &tauri::State<'_, LlmpmState>) {
    // Recover the guard even if a prior panic poisoned the mutex, so stop is
    // never silently defeated (e.g. during app-exit teardown).
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(mut p) = guard.take() {
        // SIGKILL now; `kill_on_drop` reaps when `p` drops at end of scope.
        let _ = p.child.start_kill();
    }
}

fn validate_repo(repo: &str) -> Result<(), String> {
    let r = repo.trim();
    if r.is_empty() || r.len() > 200 {
        return Err("repo id length out of range".into());
    }
    // Conservative charset (no shell metachars, no NUL/newline/space).
    if !r
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return Err("repo id contains invalid characters".into());
    }
    if r.contains("..") {
        return Err("repo id must not contain '..'".into());
    }
    // Anchor to exactly `org/name`, each segment starting alphanumeric. This
    // rejects multi-slash junk, and a segment beginning with `-` or `.` that
    // could be misread as a flag / hidden path by the downstream CLI.
    let segs: Vec<&str> = r.split('/').collect();
    if segs.len() != 2
        || segs
            .iter()
            .any(|s| !s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()))
    {
        return Err("repo id must be org/name (each part starting alphanumeric)".into());
    }
    Ok(())
}

fn validate_quant(q: &str) -> Result<(), String> {
    if q.len() > 32 || !q.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid quant string".into());
    }
    Ok(())
}

/// Strip ANSI + cap length for a streamed progress line, so a chatty/buggy
/// `llmpm` emitting a megabyte line with no newline can't balloon memory or
/// flood the event channel (mirrors the MLX drainer's per-line cap).
fn clean_progress_line(s: &str) -> String {
    strip_ansi(s).chars().take(512).collect()
}

/// Strip ANSI escape sequences from a CLI line so progress reads cleanly in UI.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip until a letter terminates the escape (CSI sequences).
            while let Some(&n) = chars.peek() {
                chars.next();
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_repo_accepts_hf_ids_rejects_metachars() {
        assert!(validate_repo("Qwen/Qwen2.5-0.5B-Instruct-GGUF").is_ok());
        assert!(validate_repo("org/name.with.dots").is_ok());
        assert!(validate_repo("bad;rm -rf").is_err());
        assert!(validate_repo("../etc/passwd").is_err());
        assert!(validate_repo("-flag").is_err());
        assert!(validate_repo("").is_err());
    }

    #[test]
    fn validate_quant_charset() {
        assert!(validate_quant("Q4_K_M").is_ok());
        assert!(validate_quant("Q8_0").is_ok());
        assert!(validate_quant("; rm").is_err());
    }

    #[test]
    fn strip_ansi_removes_escapes() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m"), "ok");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
