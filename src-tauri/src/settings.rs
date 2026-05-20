use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    pub workspace_root: Option<String>,
}

fn settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Froglips/settings.json"))
}

pub fn load() -> Settings {
    let Some(p) = settings_path() else { return Settings::default() };
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    let Some(p) = settings_path() else { return Ok(()) };
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(s)
        .unwrap_or_else(|_| "{}".to_string());
    std::fs::write(p, text)
}
