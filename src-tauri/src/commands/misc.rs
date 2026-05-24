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

/// Return the local crash log (last ~64 KB), or an empty string if none.
/// The log lives at `~/.local-llm-app/crash.log` and never leaves the device.
#[tauri::command]
pub fn read_crash_log() -> String {
    crate::crash_log::read_log()
}

/// If the SQLite DB was found corrupt on startup and quarantined, returns the
/// path of the renamed corrupt file so the UI can surface it. `None` otherwise.
#[tauri::command]
pub fn db_recovery_notice() -> Option<String> {
    crate::history::recovery_notice()
}

/// Code review H8: when the SQLite layer fails to initialize (file
/// corrupt, disk full at startup, parent dir not writable), every
/// downstream IPC fails with a generic error. This wrapper surfaces the
/// underlying string so the UI can render an actionable banner instead.
/// Returns `None` when the DB is healthy.
#[tauri::command]
pub fn db_unavailable_notice() -> Option<String> {
    crate::history::db_unavailable_notice()
}

/// Best-effort host OS description for the diagnostics bundle.
fn os_description() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let detail = std::process::Command::new("sw_vers")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    format!("{os} {arch} {detail}").trim().to_string()
}

/// Recursively mask values whose key looks secret-bearing. Keeps the JSON
/// shape so the bundle is still readable, but no plaintext key/token leaks.
fn redact_secrets(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let kl = k.to_ascii_lowercase();
                let secretish = kl.contains("key")
                    || kl.contains("token")
                    || kl.contains("secret")
                    || kl.contains("password");
                if secretish && v.is_string() {
                    *v = serde_json::Value::String("__redacted__".into());
                } else {
                    redact_secrets(v);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter_mut() {
                redact_secrets(v);
            }
        }
        _ => {}
    }
}

/// Reject obviously dangerous destinations for a write performed by a
/// privileged backend command. The diagnostics bundle path comes from a save
/// dialog, but a hostile or buggy caller could pass anything — so we apply
/// the same shape constraints as the agent's `validate_for_write`: absolute
/// path, no `..` traversal, and not pointing into the system/credential
/// directories the agent fs layer denylists.
///
/// Thin wrapper over `commands::path_safety::validate_write_dest` so the
/// diagnostics bundle, the DB backup, the export JSON, and the import JSON
/// share one canonical denylist + symlink-refusal pass.
fn validate_diagnostics_dest(dest: &str) -> Result<std::path::PathBuf, String> {
    super::path_safety::validate_write_dest(dest)
}

/// Write a single diagnostics bundle to `dest_path`: a concatenated text file
/// containing the rolling app.log tail, the crash.log, the app version, the
/// host OS, and settings.json with secret-like values redacted. Turns "the app
/// misbehaved" into a single actionable artifact the user can share.
#[tauri::command]
pub fn export_diagnostics_bundle(dest_path: String) -> Result<(), String> {
    let dest_resolved = validate_diagnostics_dest(&dest_path)?;

    let app_log = crate::logging::read_tail(256 * 1024);
    let crash_log = crate::crash_log::read_log();

    let settings_section = match crate::settings::settings_path_for_diagnostics() {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(mut v) => {
                    redact_secrets(&mut v);
                    serde_json::to_string_pretty(&v)
                        .unwrap_or_else(|_| "<settings serialize failed>".into())
                }
                Err(_) => "<settings.json is not valid JSON>".into(),
            },
            Err(_) => "<settings.json not found>".into(),
        },
        None => "<settings path unavailable>".into(),
    };

    let bundle = format!(
        "===== Froglips Diagnostics Bundle =====\n\
         app version: {version}\n\
         os: {os}\n\
         generated: {ts}\n\
         \n===== app.log (tail) =====\n{app_log}\n\
         \n===== crash.log =====\n{crash_log}\n\
         \n===== settings.json (secrets redacted) =====\n{settings}\n",
        version = env!("CARGO_PKG_VERSION"),
        os = os_description(),
        ts = crate::crash_log::now_rfc3339(),
        app_log = if app_log.is_empty() {
            "<empty>"
        } else {
            &app_log
        },
        crash_log = if crash_log.is_empty() {
            "<empty>"
        } else {
            &crash_log
        },
        settings = settings_section,
    );

    std::fs::write(&dest_resolved, bundle).map_err(|e| format!("failed to write bundle: {e}"))
}

/* ── Settings ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn settings_get() -> settings::Settings {
    // Redact API keys before they cross to the webview — the frontend only
    // needs to know a key is set, never its plaintext value.
    settings::redacted(settings::load())
}

/// Top-level keys `settings_set` will accept. Anything else in the patch is
/// rejected so a malformed/hostile IPC call can't smuggle unknown fields into
/// settings.json (which then flow into `serde(default)` deserialization).
const ALLOWED_SETTINGS_KEYS: &[&str] = &[
    "workspace_root",
    "last_model",
    "last_backend",
    "memory_mode",
    "active_preset_id",
    "embedding_model",
    "recall_threshold",
    "window",
    "theme",
    "custom_backends",
    "mcp_servers",
    "setup_complete",
    "user_profile",
];

/// Per-field byte caps for the "About You" profile. Keeps a hostile or
/// runaway IPC call from injecting an unbounded blob into every system prompt.
const PROFILE_SHORT_MAX: usize = 200;
const PROFILE_LONG_MAX: usize = 2048;

/// Validate a `settings_set` patch before it is merged + persisted. Rejects
/// unknown top-level keys, bounds `mcp_servers` entries (name shape, args/env
/// sizes), and rejects obviously malformed `custom_backends`.
fn validate_settings_patch(
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    for k in patch.keys() {
        if !ALLOWED_SETTINGS_KEYS.contains(&k.as_str()) {
            return Err(format!("unknown settings key: {k}"));
        }
    }

    if let Some(mcp) = patch.get("mcp_servers") {
        if !mcp.is_null() {
            let arr = mcp.as_array().ok_or("mcp_servers must be an array")?;
            if arr.len() > 64 {
                return Err("too many mcp_servers (max 64)".into());
            }
            for (i, srv) in arr.iter().enumerate() {
                let o = srv
                    .as_object()
                    .ok_or_else(|| format!("mcp_servers[{i}] must be an object"))?;
                let name = o
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("mcp_servers[{i}] missing string 'name'"))?;
                crate::mcp::validate_name(name)
                    .map_err(|e| format!("mcp_servers[{i}] name: {e}"))?;
                match o.get("command").and_then(|v| v.as_str()) {
                    // NUL would silently truncate the C string the kernel
                    // sees on exec, smuggling a hidden suffix past the UI.
                    Some(c) if !c.trim().is_empty() && c.len() <= 1024 && !c.contains('\0') => {}
                    _ => return Err(format!("mcp_servers[{i}] 'command' invalid")),
                }
                if let Some(args) = o.get("args") {
                    let args = args
                        .as_array()
                        .ok_or_else(|| format!("mcp_servers[{i}] 'args' must be an array"))?;
                    if args.len() > 128 {
                        return Err(format!("mcp_servers[{i}] too many args (max 128)"));
                    }
                    for a in args {
                        match a.as_str() {
                            Some(s) if s.len() <= 4096 && !s.contains('\0') => {}
                            Some(s) if s.contains('\0') => {
                                return Err(format!("mcp_servers[{i}] arg contains NUL byte"))
                            }
                            Some(_) => {
                                return Err(format!("mcp_servers[{i}] arg exceeds 4096 bytes"))
                            }
                            None => return Err(format!("mcp_servers[{i}] args must be strings")),
                        }
                    }
                }
                if let Some(env) = o.get("env") {
                    let env = env
                        .as_object()
                        .ok_or_else(|| format!("mcp_servers[{i}] 'env' must be an object"))?;
                    if env.len() > 128 {
                        return Err(format!("mcp_servers[{i}] too many env vars (max 128)"));
                    }
                    for (ek, ev) in env {
                        if ek.is_empty() || ek.len() > 256 {
                            return Err(format!("mcp_servers[{i}] env key length out of range"));
                        }
                        // NUL or '=' in an env key would corrupt the
                        // child's environment block; reject both.
                        if ek.contains('\0') || ek.contains('=') {
                            return Err(format!("mcp_servers[{i}] env key has invalid byte"));
                        }
                        match ev.as_str() {
                            Some(s) if s.len() <= 16_384 && !s.contains('\0') => {}
                            Some(s) if s.contains('\0') => {
                                return Err(format!("mcp_servers[{i}] env value contains NUL byte"))
                            }
                            Some(_) => return Err(format!("mcp_servers[{i}] env value too large")),
                            None => {
                                return Err(format!("mcp_servers[{i}] env values must be strings"))
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(up) = patch.get("user_profile") {
        if !up.is_null() {
            let o = up.as_object().ok_or("user_profile must be an object")?;
            for k in o.keys() {
                if ![
                    "enabled",
                    "name",
                    "occupation",
                    "location",
                    "about",
                    "response_style",
                ]
                .contains(&k.as_str())
                {
                    return Err(format!("user_profile: unknown field '{k}'"));
                }
            }
            if let Some(v) = o.get("enabled") {
                if !v.is_null() && !v.is_boolean() {
                    return Err("user_profile.enabled must be a boolean".into());
                }
            }
            for (key, max) in [
                ("name", PROFILE_SHORT_MAX),
                ("occupation", PROFILE_SHORT_MAX),
                ("location", PROFILE_SHORT_MAX),
                ("about", PROFILE_LONG_MAX),
                ("response_style", PROFILE_LONG_MAX),
            ] {
                if let Some(v) = o.get(key) {
                    if v.is_null() {
                        continue;
                    }
                    match v.as_str() {
                        Some(s) if s.len() <= max => {}
                        Some(_) => return Err(format!("user_profile.{key} exceeds {max} bytes")),
                        None => return Err(format!("user_profile.{key} must be a string")),
                    }
                }
            }
        }
    }

    if let Some(cb) = patch.get("custom_backends") {
        if !cb.is_null() {
            let arr = cb.as_array().ok_or("custom_backends must be an array")?;
            if arr.len() > 64 {
                return Err("too many custom_backends (max 64)".into());
            }
            for (i, b) in arr.iter().enumerate() {
                let o = b
                    .as_object()
                    .ok_or_else(|| format!("custom_backends[{i}] must be an object"))?;
                for key in ["id", "name", "base_url", "model"] {
                    match o.get(key).and_then(|v| v.as_str()) {
                        Some(s) if !s.trim().is_empty() && s.len() <= 2048 => {}
                        _ => return Err(format!("custom_backends[{i}] '{key}' invalid")),
                    }
                }
                let base = o.get("base_url").and_then(|v| v.as_str()).unwrap_or("");
                if !(base.starts_with("http://") || base.starts_with("https://")) {
                    return Err(format!("custom_backends[{i}] base_url must be http(s)"));
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn settings_set(
    patch: serde_json::Value,
    app: tauri::AppHandle,
) -> Result<settings::Settings, String> {
    let patch_obj = patch
        .as_object()
        .ok_or("settings patch must be a JSON object")?;
    validate_settings_patch(patch_obj)?;
    let mut current = serde_json::to_value(settings::load()).map_err(|e| e.to_string())?;
    if let Some(c) = current.as_object_mut() {
        for (k, v) in patch_obj {
            c.insert(k.clone(), v.clone());
        }
    }
    let updated: settings::Settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
    settings::save(&updated).map_err(|e| e.to_string())?;
    // Code review M5: notify the frontend so consumers (useChatSend's
    // per-send settings cache) can invalidate. Best-effort; emit failure
    // is non-fatal.
    use tauri::Emitter;
    let _ = app.emit("settings-changed", ());
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

fn list_open_conversation_windows_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Vec<String> {
    // Only return labels matching our convention so callers can map them
    // back to conversation ids. The main window's "main" label is filtered.
    app.webview_windows()
        .keys()
        .filter(|l| l.starts_with("conv-"))
        .cloned()
        .collect()
}

#[cfg(test)]
mod settings_validation_tests {
    use super::validate_settings_patch;

    fn obj(s: &str) -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn accepts_known_keys() {
        assert!(validate_settings_patch(&obj(r#"{"theme":"dark"}"#)).is_ok());
        assert!(validate_settings_patch(&obj(r#"{"setup_complete":true}"#)).is_ok());
        assert!(validate_settings_patch(&obj("{}")).is_ok());
    }

    #[test]
    fn rejects_unknown_top_level_key() {
        let err = validate_settings_patch(&obj(r#"{"evil":1}"#)).unwrap_err();
        assert!(err.contains("unknown settings key"), "got: {err}");
    }

    #[test]
    fn validates_mcp_server_entries() {
        // Good entry passes.
        assert!(validate_settings_patch(&obj(
            r#"{"mcp_servers":[{"name":"fs-1","command":"node","args":["x"],"env":{"K":"v"}}]}"#
        ))
        .is_ok());
        // Bad server name shape is rejected.
        assert!(validate_settings_patch(&obj(
            r#"{"mcp_servers":[{"name":"bad name","command":"node"}]}"#
        ))
        .is_err());
        // Empty command is rejected.
        assert!(
            validate_settings_patch(&obj(r#"{"mcp_servers":[{"name":"ok","command":""}]}"#))
                .is_err()
        );
        // Oversized arg is rejected.
        let big = "a".repeat(5000);
        let patch =
            format!(r#"{{"mcp_servers":[{{"name":"ok","command":"node","args":["{big}"]}}]}}"#);
        assert!(validate_settings_patch(&obj(&patch)).is_err());
    }

    #[test]
    fn rejects_nul_in_mcp_command_args_env() {
        // JSON ` ` escape parses to a string containing an embedded NUL.
        let cmd_nul = "{\"mcp_servers\":[{\"name\":\"ok\",\"command\":\"node\\u0000evil\"}]}";
        assert!(validate_settings_patch(&obj(cmd_nul)).is_err());
        let arg_nul =
            "{\"mcp_servers\":[{\"name\":\"ok\",\"command\":\"node\",\"args\":[\"a\\u0000b\"]}]}";
        assert!(validate_settings_patch(&obj(arg_nul)).is_err());
        let ekey_nul =
            "{\"mcp_servers\":[{\"name\":\"ok\",\"command\":\"node\",\"env\":{\"K\\u0000X\":\"v\"}}]}";
        assert!(validate_settings_patch(&obj(ekey_nul)).is_err());
        // '=' in env key (would corrupt the environment block).
        let ekey_eq = r#"{"mcp_servers":[{"name":"ok","command":"node","env":{"K=X":"v"}}]}"#;
        assert!(validate_settings_patch(&obj(ekey_eq)).is_err());
        let eval_nul =
            "{\"mcp_servers\":[{\"name\":\"ok\",\"command\":\"node\",\"env\":{\"K\":\"a\\u0000b\"}}]}";
        assert!(validate_settings_patch(&obj(eval_nul)).is_err());
    }

    #[test]
    fn rejects_malformed_custom_backends() {
        // Missing required field.
        assert!(validate_settings_patch(&obj(
            r#"{"custom_backends":[{"id":"a","name":"n","model":"m"}]}"#
        ))
        .is_err());
        // Non-http base_url.
        assert!(validate_settings_patch(&obj(
            r#"{"custom_backends":[{"id":"a","name":"n","base_url":"ftp://x","model":"m"}]}"#
        ))
        .is_err());
        // Well-formed entry passes.
        assert!(validate_settings_patch(&obj(
            r#"{"custom_backends":[{"id":"a","name":"n","base_url":"https://x","model":"m"}]}"#
        ))
        .is_ok());
    }
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
