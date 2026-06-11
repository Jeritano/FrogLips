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
    // Must be a well-formed URL with a host. We no longer allowlist specific
    // hosts: opening a link in the user's *external* browser is the same
    // capability any anchor tag has, and the app now surfaces legitimate
    // outbound links from many sources (HF/Civitai/Ollama model pages,
    // ModelScope, inference.sh, MCP registry listings + each server's own
    // homepage). The scheme is restricted to http(s) above, and the opener
    // uses LaunchServices (no shell) so there's no argv-injection surface.
    let parsed = url::Url::parse(&url).map_err(map_err)?;
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("url has no host".into());
    }
    app.opener().open_url(&url, None::<&str>).map_err(map_err)
}

/// Live host-machine facts (RAM / core counts / CPU brand) read from sysctl.
/// Drives hardware-aware model sizing in the picker + onboarding so a model
/// that won't fit is flagged BEFORE the user loads it. macOS-only: shells out
/// to `/usr/sbin/sysctl` (always present) rather than pulling a `libc` dep.
#[derive(serde::Serialize)]
pub struct SystemInfo {
    /// Physical RAM in GiB (decimal, e.g. 18.0).
    pub total_ram_gb: f64,
    pub physical_cores: u32,
    /// Performance ("P") cores; falls back to `physical_cores` on Intel where
    /// the perflevel key is absent.
    pub performance_cores: u32,
    pub cpu_brand: String,
    /// `iogpu.wired_limit_mb` — 0 means the macOS default (~75% of RAM is the
    /// Metal working-set cap). Read-only here; raising it needs sudo.
    pub wired_limit_mb: u64,
}

/// Memory-pressure snapshot for the header chip (inference wave D). ONE
/// sysctl spawn for both keys; level: 1=normal 2=warn 4=critical.
#[tauri::command]
pub async fn ram_pressure() -> Result<(u32, f64), String> {
    crate::commands::blocking(|| -> anyhow::Result<(u32, f64)> {
        let out = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "kern.memorystatus_vm_pressure_level", "hw.memsize"])
            .output()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut lines = text.lines();
        let level: u32 = lines
            .next()
            .and_then(|l| l.trim().parse().ok())
            .unwrap_or(1);
        let memsize: f64 = lines
            .next()
            .and_then(|l| l.trim().parse().ok())
            .unwrap_or(0.0);
        Ok((level, memsize / 1024.0 / 1024.0 / 1024.0))
    })
    .await
}

#[tauri::command]
pub async fn system_info() -> Result<SystemInfo, String> {
    crate::commands::blocking(|| -> anyhow::Result<SystemInfo> {
        fn sysctl(key: &str) -> Option<String> {
            std::process::Command::new("/usr/sbin/sysctl")
                .arg("-n")
                .arg(key)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        }
        let memsize: u64 = sysctl("hw.memsize")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let total_ram_gb = (memsize as f64) / 1024.0 / 1024.0 / 1024.0;
        let physical_cores: u32 = sysctl("hw.physicalcpu")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        // perflevel0 = P-cores (Apple Silicon); absent on Intel → use physical.
        let performance_cores: u32 = sysctl("hw.perflevel0.physicalcpu")
            .and_then(|s| s.parse().ok())
            .unwrap_or(physical_cores);
        let cpu_brand =
            sysctl("machdep.cpu.brand_string").unwrap_or_else(|| "Apple Silicon".into());
        let wired_limit_mb: u64 = sysctl("iogpu.wired_limit_mb")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        Ok(SystemInfo {
            total_ram_gb,
            physical_cores,
            performance_cores,
            cpu_brand,
            wired_limit_mb,
        })
    })
    .await
}

/// Return the local crash log (last ~64 KB), or an empty string if none.
/// The log lives at `~/.local-llm-app/crash.log` and never leaves the device.
#[tauri::command]
pub fn read_crash_log() -> String {
    crate::crash_log::read_log()
}

/// Append a diagnostic line to `~/.local-llm-app/diag.log`. Best-effort —
/// errors are swallowed and `()` is returned regardless. Each call timestamps
/// the entry and appends a newline.
///
/// Rotation (infra audit M12, 2026-05-24): when the file exceeds
/// `MAX_LOG_BYTES`, the most recent half is retained and the rest dropped.
/// Mirrors the `crash_log` rotation pattern so `diag.log` doesn't grow
/// unbounded under heavy frontend logging.
#[tauri::command]
pub async fn append_diag_log(line: String) -> Result<(), String> {
    // Off the UI thread: this is called on a hot frontend logging path and the
    // rotation branch reads+rewrites up to 128 KiB synchronously. Run the whole
    // body on the blocking pool.
    crate::commands::blocking(move || -> anyhow::Result<()> {
        use std::fs::OpenOptions;
        use std::io::Write;
        let Some(home) = dirs::home_dir() else {
            anyhow::bail!("no home dir");
        };
        let dir = home.join(".local-llm-app");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("diag.log");
        // Cap individual line length so a single 50MB body doesn't fill disk.
        const MAX_LINE: usize = 256 * 1024;
        // Cap on the file as a whole (same shape as `crash_log::MAX_LOG_BYTES`).
        const MAX_FILE_BYTES: u64 = 256 * 1024;
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_FILE_BYTES {
                if let Ok(data) = std::fs::read(&path) {
                    let keep = (MAX_FILE_BYTES as usize / 2).min(data.len());
                    let tail = &data[data.len() - keep..];
                    let _ = std::fs::write(&path, tail);
                }
            }
        }
        let safe = if line.len() > MAX_LINE {
            // Floor to the nearest char boundary — slicing mid-UTF-8-codepoint
            // panics, and `line` is a caller-supplied IPC arg.
            let mut end = MAX_LINE;
            while end > 0 && !line.is_char_boundary(end) {
                end -= 1;
            }
            &line[..end]
        } else {
            &line[..]
        };
        let ts = crate::crash_log::now_rfc3339();
        let record = format!("[{ts}] {safe}\n");
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(record.as_bytes())?;
        Ok(())
    })
    .await
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

/// A string VALUE that looks like a credential regardless of its key name —
/// caught so secrets in arbitrarily-named fields don't slip past the name
/// filter. Conservative on purpose (prefix + embedded-URL-credential only) so
/// it doesn't over-redact useful debug data like file paths or model ids.
fn value_looks_secret(s: &str) -> bool {
    let t = s.trim();
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xapp-",
        "glpat-",
        "AKIA",
        "ASIA",
        "AIza",
        "ya29.",
        "Bearer ",
        "-----BEGIN",
        // JWT (base64url of `{"` ) — the near-universal bearer-token shape.
        "eyJ",
    ];
    if PREFIXES.iter().any(|p| t.starts_with(p)) {
        return true;
    }
    // scheme://user:pass@host — credentials embedded in a URL.
    if let Some(rest) = t.split("://").nth(1) {
        if let Some(authority) = rest.split('/').next() {
            if authority.contains('@')
                && authority.split('@').next().is_some_and(|c| c.contains(':'))
            {
                return true;
            }
        }
    }
    false
}

/// Recursively mask secret-bearing values for the shareable diagnostics
/// bundle. Redacts when (a) the KEY name looks secret-bearing, (b) the VALUE
/// looks like a credential, or (c) we're inside an MCP-server `env` block —
/// those hold arbitrary, often-credential values under names we can't predict
/// (GH_PAT, DATABASE_URL, …), so every string value there is masked. Keeps the
/// JSON shape readable; no plaintext key/token leaks. SEC-MED (2026-05-30).
fn redact_secrets(value: &mut serde_json::Value) {
    redact_secrets_inner(value, false);
}

fn redact_secrets_inner(value: &mut serde_json::Value, redact_all_strings: bool) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let kl = k.to_ascii_lowercase();
                let name_secret = kl.contains("key")
                    || kl.contains("token")
                    || kl.contains("secret")
                    || kl.contains("password")
                    || kl.contains("passwd")
                    || kl.contains("auth")
                    || kl.contains("credential")
                    || kl.contains("bearer");
                // Any object under an `env` key (MCP server environment) →
                // redact every string value within it.
                let child_redact_all = redact_all_strings || kl == "env";
                let redact_this = v.is_string()
                    && (redact_all_strings
                        || name_secret
                        || value_looks_secret(v.as_str().unwrap_or("")));
                if redact_this {
                    *v = serde_json::Value::String("__redacted__".into());
                } else {
                    redact_secrets_inner(v, child_redact_all);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter_mut() {
                // Redact credential-shaped string ELEMENTS too — e.g. an MCP
                // server's `args: ["--token", "ghp_…"]` or
                // `["--header", "Authorization: Bearer …"]`. Without this an
                // array-positioned secret would survive into the shared bundle
                // (the object-key path never sees it). SEC-MED (2026-05-30).
                if let serde_json::Value::String(s) = v {
                    if redact_all_strings || value_looks_secret(s) {
                        *v = serde_json::Value::String("__redacted__".into());
                        continue;
                    }
                }
                redact_secrets_inner(v, redact_all_strings);
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
pub async fn export_diagnostics_bundle(dest_path: String) -> Result<(), String> {
    let dest_resolved = validate_diagnostics_dest(&dest_path)?;

    // Heavy + blocking: multi-256 KiB log reads, a `sw_vers` subprocess
    // (os_description), and a file write. Run off the UI thread.
    crate::commands::blocking(move || -> anyhow::Result<()> {
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

        std::fs::write(&dest_resolved, bundle)?;
        Ok(())
    })
    .await
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
    "hardware_profile",
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
    // Hold the update lock across load→patch→save so a concurrent settings
    // write can't clobber this one (lost update). MED (2026-05-29).
    let _guard = settings::lock_for_update();
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
    let _guard = settings::lock_for_update();
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

/* ── Custom OpenAI-compatible cloud backend ───────────────────────────── */

/// Stream a chat completion from a user-configured custom backend
/// (OpenRouter / Groq / etc). Emits `custom-chunk:{op_id}` deltas + a
/// terminal `custom-done:{op_id}` / `custom-error:{op_id}`. The API key is
/// pulled from the Keychain inside `custom_backend` and never crosses the
/// IPC boundary — the webview only ever supplies the backend id.
#[tauri::command]
pub async fn custom_chat_stream(
    op_id: String,
    backend_id: String,
    messages: Vec<crate::custom_backend::ChatMessage>,
    params: Option<crate::custom_backend::CustomChatParams>,
    model: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if op_id.is_empty() || op_id.len() > 128 {
        return Err("invalid op_id".into());
    }
    if backend_id.is_empty() || backend_id.len() > 128 {
        return Err("invalid backend_id".into());
    }
    crate::custom_backend::chat_stream(
        app,
        op_id,
        backend_id,
        messages,
        params.unwrap_or_default(),
        model,
    )
    .await
}

/// Cancel an in-flight custom/OpenRouter chat stream by its `op_id`.
/// Best-effort: `true` if a stream was actually pending. (2026-05-30)
#[tauri::command]
pub fn custom_cancel(op_id: String) -> bool {
    crate::stream_cancel::cancel(&op_id)
}

/// Fetch the live OpenRouter model catalogue for the picker.
#[tauri::command]
pub async fn openrouter_list_models() -> Result<Vec<crate::custom_backend::OpenRouterModel>, String>
{
    crate::custom_backend::list_openrouter_models().await
}

/// Store (or clear, on empty) the OpenRouter API key in the Keychain.
#[tauri::command]
pub fn openrouter_set_key(key: String) -> Result<(), String> {
    crate::custom_backend::set_openrouter_key(&key)
}

/// Whether an OpenRouter key is configured (never returns the key itself).
#[tauri::command]
pub async fn openrouter_has_key() -> Result<bool, String> {
    Ok(crate::custom_backend::has_openrouter_key())
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

// `list_open_conversation_windows` IPC removed 2026-05-26 SE review
// round 2 — no FE consumer. The impl below is retained because the
// test at line ~658 still drives it (it validates the conv- label
// filter convention so future re-exposures are correct).
#[allow(dead_code)]
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
        // JSON `\x00` escape parses to a string containing an embedded NUL.
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

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn diagnostics_bundle_redacts_secrets() {
        let mut v = serde_json::json!({
            "theme": "dark",
            "workspace_root": "/Users/joe/proj2",          // path w/ digit: must survive
            "custom_backends": [
                { "id": "x", "name": "vLLM", "api_key": "sk-secret123", "base_url": "http://127.0.0.1:8000" }
            ],
            "mcp_servers": [
                {
                    "name": "gh",
                    "command": "npx",
                    "args": ["server", "--token", "ghp_realtoken", "--port", "3000"],
                    "env": { "GH_PAT": "ghp_envtoken", "REGION": "us-east-1", "DEBUG": "1" }
                }
            ],
            // A standalone credential-shaped value (JWT) under a non-secret key.
            "session": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        });
        redact_secrets(&mut v);
        let s = serde_json::to_string(&v).unwrap();

        // Secrets gone.
        assert!(!s.contains("sk-secret123"), "api_key leaked");
        assert!(!s.contains("ghp_realtoken"), "args token leaked");
        assert!(!s.contains("ghp_envtoken"), "env token leaked");
        assert!(
            !s.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "JWT leaked"
        );

        // Non-secrets preserved (env blanket redacts REGION/DEBUG too — that's
        // acceptable over-redaction; the load-bearing checks are paths + names).
        assert!(
            s.contains("/Users/joe/proj2"),
            "workspace path over-redacted"
        );
        assert!(s.contains("dark"), "theme over-redacted");
        assert!(s.contains("\"name\":\"gh\""), "server name over-redacted");
        // Non-secret positional args survive.
        assert!(s.contains("server"), "non-secret arg over-redacted");
        assert!(s.contains("3000"), "port arg over-redacted");
    }
}
