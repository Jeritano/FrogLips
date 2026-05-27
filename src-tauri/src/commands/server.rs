//! Backend server lifecycle and availability probes.

use tauri::{Emitter, State};

use super::{map_err, ServerHandle};
use crate::backend_process::ServerStatus;

#[tauri::command]
pub async fn start_server(
    model: String,
    backend: String,
    state: State<'_, ServerHandle>,
    app: tauri::AppHandle,
) -> Result<ServerStatus, String> {
    if backend != "mlx" && backend != "ollama" {
        return Err(format!("invalid backend: {backend}"));
    }
    if model.trim().is_empty() {
        return Err("model id must not be empty".into());
    }
    // SWE-H5 (2026-05-24): the model string is forwarded as `--model <model>`
    // argv to the spawned process. Without character validation a model id
    // beginning with `--` (e.g. `--trust-remote-code`) is parsed by clap as
    // a server flag rather than as the model name. The pull paths already
    // validate via these regexes — do the same on start.
    match backend.as_str() {
        "ollama" => super::validate_ollama_name(&model)?,
        "mlx" => super::validate_hf_repo(&model)?,
        _ => unreachable!("backend already validated above"),
    }
    let status = state.start(model, backend).await.map_err(map_err)?;
    let _ = app.emit("server-status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn stop_server(
    state: State<'_, ServerHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.stop().await;
    let _ = app.emit("server-status", &state.status().await);
    Ok(())
}

#[tauri::command]
pub async fn server_status(state: State<'_, ServerHandle>) -> Result<ServerStatus, String> {
    Ok(state.status().await)
}

/// Probe for an installed MLX server by attempting `mlx_lm.server --help`.
/// Returns Ok(true) if the binary exists on PATH and exits cleanly within
/// the timeout; Ok(false) on missing-binary / non-zero exit / timeout. We
/// never surface an Err here — the wizard treats "probe errored" the same
/// as "backend unavailable" and the user can still pick a different option.
#[tauri::command]
pub async fn mlx_probe() -> bool {
    const MLX_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
    let fut = tokio::process::Command::new("mlx_lm.server")
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    match tokio::time::timeout(MLX_PROBE_TIMEOUT, fut).await {
        Ok(Ok(status)) => status.success(),
        _ => false,
    }
}

/// Probe for a running Ollama daemon via the official tags endpoint with a
/// 1s hard ceiling. Hardcoded to localhost:11434 so there's no SSRF surface
/// (the URL isn't user-controlled). Any error → false.
#[tauri::command]
pub async fn ollama_probe() -> bool {
    const OLLAMA_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
    let client = match reqwest::Client::builder()
        .timeout(OLLAMA_PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get("http://127.0.0.1:11434/api/tags").send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}
