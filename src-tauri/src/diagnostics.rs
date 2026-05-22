//! Rust → frontend diagnostics bridge.
//!
//! A thin helper that emits a `app-diagnostics` Tauri event so warnings
//! that previously went to stderr-only (`eprintln!`) also surface in the
//! in-app Diagnostics panel.
//!
//! Observation-only — emitting a diagnostic must never alter the
//! surrounding control flow. If no `AppHandle` is available yet (e.g. an
//! auto-start task running before `setup()` finished) we fall back to
//! stderr alone.

use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// The `level` field on a `DiagEvent`. Matches the frontend `DiagLevel`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagLevel {
    Info,
    Warn,
    Error,
}

impl DiagLevel {
    /// String form of the level. Retained for the serde-parity unit test and
    /// any future stderr-style formatting.
    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            DiagLevel::Info => "info",
            DiagLevel::Warn => "warn",
            DiagLevel::Error => "error",
        }
    }
}

/// Payload of the `app-diagnostics` event. Shape matches the frontend
/// `Omit<DiagEntry, "ts">` so the React listener can forward it directly
/// into `logDiag()`.
#[derive(Debug, Clone, Serialize)]
pub struct DiagEvent {
    pub level: DiagLevel,
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

/// Global app-handle slot. Populated once during `setup()` so background
/// tasks (MCP auto-start, RAG ingest workers, etc.) can emit without
/// threading an `AppHandle` through every call site.
static APP_HANDLE: RwLock<Option<AppHandle>> = RwLock::new(None);

/// Install the AppHandle. Called once from `setup()` after the Tauri app
/// is fully built. Subsequent calls are no-ops (first one wins).
pub fn set_app_handle(handle: AppHandle) {
    let mut g = APP_HANDLE.write();
    if g.is_none() {
        *g = Some(handle);
    }
}

fn emit(level: DiagLevel, source: &str, message: &str, detail: Option<Value>) {
    // Route through `tracing` so the event lands in the persistent rolling
    // log at ~/.local-llm-app/app.log (and stderr, via the fmt subscriber).
    // Non-panic failures are now durable across restarts.
    let detail_str = detail.as_ref().map(|d| d.to_string()).unwrap_or_default();
    match level {
        DiagLevel::Info => {
            tracing::info!(target: "diagnostics", source, detail = %detail_str, "{message}")
        }
        DiagLevel::Warn => {
            tracing::warn!(target: "diagnostics", source, detail = %detail_str, "{message}")
        }
        DiagLevel::Error => {
            tracing::error!(target: "diagnostics", source, detail = %detail_str, "{message}")
        }
    }

    let handle = APP_HANDLE.read().clone();
    if let Some(h) = handle {
        let payload = DiagEvent {
            level,
            source: source.to_string(),
            message: message.to_string(),
            detail,
        };
        // Best-effort emit — a disconnected webview (e.g. window closed
        // mid-shutdown) must not abort the surrounding operation.
        let _ = h.emit("app-diagnostics", &payload);
    }
}

/// Emit an `info`-level diagnostic.
pub fn info(source: &str, message: &str) {
    emit(DiagLevel::Info, source, message, None);
}

/// Emit a `warn`-level diagnostic.
#[allow(dead_code)]
pub fn warn(source: &str, message: &str) {
    emit(DiagLevel::Warn, source, message, None);
}

/// Emit a `warn` with optional structured detail.
pub fn warn_with(source: &str, message: &str, detail: Value) {
    emit(DiagLevel::Warn, source, message, Some(detail));
}

/// Emit an `error`-level diagnostic.
#[allow(dead_code)]
pub fn error(source: &str, message: &str) {
    emit(DiagLevel::Error, source, message, None);
}

/// Emit an `error` with optional structured detail.
#[allow(dead_code)]
pub fn error_with(source: &str, message: &str, detail: Value) {
    emit(DiagLevel::Error, source, message, Some(detail));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diag_level_serializes_lowercase() {
        let payload = DiagEvent {
            level: DiagLevel::Warn,
            source: "test".into(),
            message: "hello".into(),
            detail: None,
        };
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"level\":\"warn\""));
        assert!(s.contains("\"source\":\"test\""));
    }

    #[test]
    fn diag_emit_without_handle_falls_back_to_stderr() {
        // Should not panic when APP_HANDLE is absent.
        emit(DiagLevel::Info, "test", "no handle", None);
        emit(
            DiagLevel::Warn,
            "test",
            "no handle",
            Some(json!({"k": "v"})),
        );
    }

    #[test]
    fn diag_level_as_str_matches_serde() {
        assert_eq!(DiagLevel::Info.as_str(), "info");
        assert_eq!(DiagLevel::Warn.as_str(), "warn");
        assert_eq!(DiagLevel::Error.as_str(), "error");
    }
}
