//! Persistent on-disk logging via `tracing`.
//!
//! Initializes a daily-rolling, size-bounded log file at
//! `~/.local-llm-app/app.log`. Non-panic failures previously vanished on
//! restart (`eprintln!` only); now every `diagnostics` emission is also
//! durably recorded here. The in-webview event stream is kept additively.

use std::path::PathBuf;
use std::sync::OnceLock;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

/// Keeps the non-blocking writer's worker thread alive for the process
/// lifetime. Dropping the guard would flush and stop logging.
static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Directory holding `app.log` (and siblings). Same base as the DB / crash log.
fn log_dir() -> Option<PathBuf> {
    let base = dirs::home_dir()?.join(".local-llm-app");
    std::fs::create_dir_all(&base).ok()?;
    Some(base)
}

/// Path of the active log file.
pub fn log_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join("app.log"))
}

/// Initialize the rolling on-disk logger. Idempotent — only the first call
/// installs a subscriber; later calls are no-ops. Safe to call before the
/// Tauri app is built. Returns silently if the home directory is unavailable.
pub fn init() {
    if GUARD.get().is_some() {
        return;
    }
    let Some(dir) = log_dir() else { return };

    // Daily rotation keeps each file bounded; `max_log_files` caps total
    // retention so the directory can't grow without limit.
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("app")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&dir);
    let appender = match appender {
        Ok(a) => a,
        Err(_) => return,
    };

    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    let _ = GUARD.set(guard);

    // Default to INFO; honour RUST_LOG if the developer sets it.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .try_init();
}

/// Read the tail of the current `app.log`, capped at `max_bytes`. Returns an
/// empty string when no log exists. Used by the diagnostics bundle exporter.
pub fn read_tail(max_bytes: usize) -> String {
    let Some(path) = log_path() else {
        return String::new();
    };
    let Ok(data) = std::fs::read(&path) else {
        return String::new();
    };
    let start = data.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&data[start..]).into_owned()
}
