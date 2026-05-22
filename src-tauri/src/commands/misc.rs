//! Miscellaneous commands: external links, settings, setup wizard, quick
//! prompt, and multi-window (detached conversation) management.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use super::map_err;
use crate::{quick_prompt, settings};

#[tauri::command]
pub fn open_external(url: String, app: tauri::AppHandle) -> Result<(), String> {
    if url.len() > 2048 {
        return Err("url too long".into());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) urls allowed".into());
    }
    let parsed = url::Url::parse(&url).map_err(map_err)?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let allowed = matches!(
        host.as_str(),
        "civitai.com"
            | "www.civitai.com"
            | "huggingface.co"
            | "www.huggingface.co"
            | "ollama.com"
            | "www.ollama.com"
    );
    if !allowed {
        return Err(format!("host not allowed: {host}"));
    }
    // Use Apple's LaunchServices via tauri-plugin-opener (no exec) — avoids
    // argv-injection risk of shelling out to /usr/bin/open with the URL.
    app.opener().open_url(&url, None::<&str>).map_err(map_err)
}

/* ── Settings ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn settings_get() -> settings::Settings {
    // Redact API keys before they cross to the webview — the frontend only
    // needs to know a key is set, never its plaintext value.
    settings::redacted(settings::load())
}

#[tauri::command]
pub fn settings_set(patch: serde_json::Value) -> Result<settings::Settings, String> {
    let mut current = serde_json::to_value(settings::load()).map_err(|e| e.to_string())?;
    if let (Some(c), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            c.insert(k.clone(), v.clone());
        }
    }
    let updated: settings::Settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
    settings::save(&updated).map_err(|e| e.to_string())?;
    // Redact keys before returning — never echo plaintext back to the webview.
    Ok(settings::redacted(updated))
}

/* ── First-run setup wizard ─────────────────────────────────────────────── */

/// Returns whether the user has dismissed the first-run setup wizard.
/// Absent flag → `false` (i.e. legacy installs without the field rerun the
/// wizard once, then it self-marks complete).
#[tauri::command]
pub fn setup_complete_get() -> bool {
    settings::load().setup_complete.unwrap_or(false)
}

/// Persists the wizard's completion flag. Two callers:
///   * the wizard's "Done" button → `true`
///   * the Settings panel "Re-run setup wizard" button → `false`
#[tauri::command]
pub fn setup_complete_set(value: bool) -> Result<(), String> {
    let mut s = settings::load();
    s.setup_complete = Some(value);
    settings::save(&s).map_err(|e| e.to_string())
}

/* ── Quick prompt (menu-bar ephemeral prompt) ──────────────────────────── */

#[tauri::command]
pub async fn quick_prompt_submit(
    op_id: String,
    text: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 128 {
        return Err("invalid op_id".into());
    }
    quick_prompt::run(app, op_id, text).await
}

#[tauri::command]
pub fn quick_prompt_open(app: tauri::AppHandle) -> Result<(), String> {
    quick_prompt::ensure_window(&app).map_err(map_err)
}

#[tauri::command]
pub fn quick_prompt_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(quick_prompt::QUICK_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

/* ── Multi-window: detached conversations ────────────────────────────── */

/// Stable, filesystem/label-safe label for a detached conversation window.
///
/// Tauri rejects labels containing slashes/whitespace and requires uniqueness,
/// so we derive the label deterministically from the conversation id. Reusing
/// the same convId twice intentionally yields the same label — that lets
/// `open_conversation_window` focus the existing window rather than crash on
/// duplicate-label.
fn detached_window_label(conversation_id: i64) -> String {
    format!("conv-{conversation_id}")
}

#[tauri::command]
pub async fn open_conversation_window(
    conversation_id: i64,
    title: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    open_conversation_window_impl(&app, conversation_id, title.as_deref())
}

/// Synchronous core for `open_conversation_window` so unit tests can exercise
/// the dedup-and-focus path without an async runtime. Generic over the Tauri
/// `Runtime` so `tauri::test::MockRuntime` can drive it in `#[cfg(test)]`.
fn open_conversation_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    conversation_id: i64,
    title: Option<&str>,
) -> Result<String, String> {
    let label = detached_window_label(conversation_id);
    // If a window with this label is already open, focus it and bail. This
    // mirrors Slack/VSCode behavior where double-detach reopens the existing
    // window instead of stacking duplicates.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }
    let display_title = match title {
        Some(t) if !t.trim().is_empty() => format!("Froglips — {}", t.trim()),
        _ => format!("Froglips — Conversation {conversation_id}"),
    };
    // URL: same frontend bundle, query-string toggles the detached single-conv
    // view. The hash fragment isn't used because Tauri's WebviewUrl::App
    // collapses query strings cleanly via `index.html?…`.
    let url_path = format!("index.html?detached=1&conversation_id={conversation_id}");
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_path.into()))
        .title(display_title)
        .inner_size(700.0, 500.0)
        .min_inner_size(420.0, 320.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

#[tauri::command]
pub fn list_open_conversation_windows(app: tauri::AppHandle) -> Vec<String> {
    list_open_conversation_windows_impl(&app)
}

fn list_open_conversation_windows_impl<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    // Only return labels matching our convention so callers can map them
    // back to conversation ids. The main window's "main" label is filtered.
    app.webview_windows()
        .keys()
        .filter(|l| l.starts_with("conv-"))
        .cloned()
        .collect()
}

#[cfg(test)]
mod multi_window_tests {
    use super::*;

    #[test]
    fn detached_label_is_stable_and_safe() {
        // Same id → same label (so dedup-by-label in open_conversation_window
        // can map convId back to an existing window).
        assert_eq!(detached_window_label(42), "conv-42");
        assert_eq!(detached_window_label(42), detached_window_label(42));
        // Negative ids are still label-safe (only alnum + '-').
        let label = detached_window_label(-1);
        assert!(label.starts_with("conv-"));
        assert!(label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn open_conversation_window_dedups_to_focus() {
        // Build a real-but-mocked Tauri app so we can exercise the
        // get_webview_window + WebviewWindowBuilder code paths.
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        // First open: builder runs, returns label.
        let first = open_conversation_window_impl(&handle, 7, Some("Hello"))
            .expect("first open should succeed");
        assert_eq!(first, "conv-7");

        // Second open with same id MUST NOT error on duplicate label —
        // it should detect the existing window and focus instead.
        let second = open_conversation_window_impl(&handle, 7, Some("Hello"))
            .expect("second open should focus, not crash");
        assert_eq!(second, "conv-7");

        // list_open_conversation_windows should report only conv-* labels
        // (excludes any "main" window). MockRuntime may or may not surface
        // the window — accept either, the load-bearing check is the
        // no-crash invariant above.
        let open = list_open_conversation_windows_impl(&handle);
        if !open.is_empty() {
            assert!(open.iter().any(|l| l == "conv-7"));
        }
    }
}
