use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Settings {
    pub workspace_root: Option<String>,
    pub last_model: Option<String>,
    pub last_backend: Option<String>,
    pub memory_mode: Option<String>,
    pub active_preset_id: Option<String>,
    pub embedding_model: Option<String>,
    pub recall_threshold: Option<f32>,
    pub window: Option<WindowGeometry>,
    pub theme: Option<String>, // "dark" | "light"
    pub custom_backends: Option<Vec<CustomBackend>>,
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    /// First-run setup wizard completion flag. Defaults to `false` for a
    /// fresh install so the wizard auto-opens; the Settings panel exposes a
    /// "Re-run setup wizard" button that flips this back to `false` on demand.
    /// Wrapped in `Option` so users on older settings.json files (where the
    /// field is absent) deserialize as `None` → wizard treats as `false` →
    /// runs once, then writes `Some(true)` and never bothers them again.
    pub setup_complete: Option<bool>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct CustomBackend {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Whether this server should be auto-started when the app launches.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn settings_path() -> Option<PathBuf> {
    // Test override: allows the cargo test suite to point at a tempdir without
    // clobbering the developer's real ~/Library/Application Support/Froglips
    // file. Production code never sets this env var.
    if let Ok(dir) = std::env::var("FROGLIPS_SETTINGS_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("settings.json"));
        }
    }
    dirs::config_dir().map(|d| d.join("Froglips/settings.json"))
}

pub fn load() -> Settings {
    let Some(p) = settings_path() else {
        return Settings::default();
    };
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    let Some(p) = settings_path() else {
        return Ok(());
    };
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(s).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(p, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the `FROGLIPS_SETTINGS_DIR` env var across parallel tests so two
    /// settings tests don't clobber each other's tempdirs. `std::env::set_var`
    /// is process-global, so serialize via a mutex even though the rest of the
    /// codebase is mostly free of env-mutating tests.
    static ENV_GUARD: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn with_tempdir<F: FnOnce(&std::path::Path)>(f: F) {
        let _g = ENV_GUARD.lock();
        // Stable random-ish path under the OS temp dir; we clean up after.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("froglips-settings-test-{nonce}"));
        std::fs::create_dir_all(&dir).expect("create tempdir");
        // SAFETY: serialized via ENV_GUARD; env mutation is process-global but
        // only test threads holding the guard observe it.
        std::env::set_var("FROGLIPS_SETTINGS_DIR", &dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&dir)));
        std::env::remove_var("FROGLIPS_SETTINGS_DIR");
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// Round-trip the wizard's setup-complete flag through `save → load` to
    /// guarantee the persistence path actually writes + reads the field. This
    /// is the only state the wizard relies on to decide whether to show
    /// itself on launch, so a regression here would re-show the wizard every
    /// startup.
    #[test]
    fn setup_complete_roundtrips_through_disk() {
        with_tempdir(|_dir| {
            // Initial load on a fresh dir → None (legacy/absent → wizard runs).
            let s0 = load();
            assert_eq!(s0.setup_complete, None);

            // Flip to true, persist, reload — must come back true.
            let mut s = s0.clone();
            s.setup_complete = Some(true);
            save(&s).expect("save 1");
            let s1 = load();
            assert_eq!(s1.setup_complete, Some(true));

            // Flip back to false (the "re-run wizard" code path) — same.
            let mut s = s1.clone();
            s.setup_complete = Some(false);
            save(&s).expect("save 2");
            let s2 = load();
            assert_eq!(s2.setup_complete, Some(false));
        });
    }
}
