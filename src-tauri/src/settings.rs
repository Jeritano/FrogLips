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
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct CustomBackend {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
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
