//! Model management: discovery, pulls/deletes, native inference, GGUF files.

use tauri::{Emitter, Manager};

use super::{blocking, map_err, validate_hf_repo, validate_ollama_name, NativeHandle};
use crate::models::ModelEntry;
use crate::{gguf, models, native_inference, ollama_library};

#[derive(serde::Serialize)]
pub struct AllModels {
    mlx: Vec<ModelEntry>,
    ollama: Vec<ModelEntry>,
    mlx_error: Option<String>,
    ollama_error: Option<String>,
}

#[tauri::command]
pub async fn list_all_models() -> Result<AllModels, String> {
    blocking(|| {
        let lists = models::list_all_models()?;
        Ok(AllModels {
            mlx: lists.mlx,
            ollama: lists.ollama,
            mlx_error: lists.mlx_error,
            ollama_error: lists.ollama_error,
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_ollama_model(name: String) -> Result<(), String> {
    validate_ollama_name(&name)?;
    blocking(move || models::delete_ollama_model(&name)).await
}

#[tauri::command]
pub async fn delete_mlx_model(repo_id: String) -> Result<(), String> {
    validate_hf_repo(&repo_id)?;
    blocking(move || models::delete_mlx_model(&repo_id)).await
}

/// Cap on stdout/stderr buffered from a model-pull child. The CLIs emit
/// progress to stderr for up to 30 minutes — `.output()` would buffer all of
/// it in memory unbounded; this caps it.
const PULL_OUTPUT_CAP: usize = 64 * 1024;

/// Run `cmd` to completion, draining stdout+stderr each capped at
/// `PULL_OUTPUT_CAP` bytes so a chatty/long-running pull cannot OOM the app.
/// Returns `(success, stderr_text)`.
async fn run_capped_pull(mut cmd: tokio::process::Command) -> Result<(bool, String), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    async fn drain<R: tokio::io::AsyncRead + Unpin>(mut r: R, cap: usize) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = r.read(&mut chunk).await {
            if n == 0 || buf.len() >= cap {
                break;
            }
            let take = n.min(cap - buf.len());
            buf.extend_from_slice(&chunk[..take]);
        }
        buf
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_fut = async {
        match stdout {
            Some(s) => drain(s, PULL_OUTPUT_CAP).await,
            None => Vec::new(),
        }
    };
    let err_fut = async {
        match stderr {
            Some(s) => drain(s, PULL_OUTPUT_CAP).await,
            None => Vec::new(),
        }
    };
    let (_out, err) = tokio::join!(out_fut, err_fut);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok((status.success(), String::from_utf8_lossy(&err).into_owned()))
}

#[tauri::command]
pub async fn pull_ollama_model(name: String) -> Result<String, String> {
    validate_ollama_name(&name)?;
    const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let mut cmd = tokio::process::Command::new("ollama");
    cmd.arg("pull").arg("--").arg(&name);
    match tokio::time::timeout(PULL_TIMEOUT, run_capped_pull(cmd)).await {
        Ok(Ok((true, _))) => Ok(format!("Pulled {name}")),
        Ok(Ok((false, stderr))) => Err(stderr),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs())),
    }
}

#[tauri::command]
pub async fn pull_hf_model(repo_id: String) -> Result<String, String> {
    validate_hf_repo(&repo_id)?;
    let home = dirs::home_dir().unwrap_or_default();
    // Upper bound on a single attempt — 30 minutes is enough for any sane model
    // on a fast connection, and prevents the IPC command from hanging forever
    // if the CLI stalls on auth or network.
    const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let candidates: Vec<(std::path::PathBuf, &str)> = vec![
        (home.join(".venvs/mlx/bin/hf"), "download"),
        (std::path::PathBuf::from("hf"), "download"),
        (home.join(".venvs/mlx/bin/huggingface-cli"), "download"),
        (std::path::PathBuf::from("huggingface-cli"), "download"),
    ];
    let mut last_err = String::from("no huggingface CLI found");
    for (bin, sub) in candidates {
        if bin.is_absolute() && !bin.exists() {
            continue;
        }
        // kill_on_drop: if the timeout fires and we drop the future, the
        // child download is also killed instead of leaking and burning
        // bandwidth. Output is drained capped (the CLI streams MBs of
        // progress to stderr) so a long pull cannot buffer unbounded.
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg(sub).arg("--").arg(&repo_id);
        match tokio::time::timeout(PULL_TIMEOUT, run_capped_pull(cmd)).await {
            Ok(Ok((success, stderr))) => {
                if success && !stderr.contains("deprecated and no longer works") {
                    return Ok(format!("Downloaded {repo_id}"));
                }
                last_err = stderr;
            }
            Ok(Err(e)) => {
                last_err = e;
            }
            Err(_) => {
                return Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs()));
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn ollama_library_fetch() -> Result<Vec<ollama_library::OllamaLibraryEntry>, String> {
    // Returns the cached/scraped contents of ollama.com/library. On failure
    // the frontend falls back to its curated `OLLAMA` array — never panics.
    ollama_library::fetch().await
}

/* ── Native inference (alpha; behind `--features native-inference`) ───── */

#[tauri::command]
pub async fn native_supported() -> bool {
    native_inference::native_enabled()
}

#[tauri::command]
pub async fn native_load_model(
    model_id: String,
    state: tauri::State<'_, NativeHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !native_inference::native_enabled() {
        return Err(
            "native inference not compiled in (rebuild with --features native-inference)".into(),
        );
    }
    let _ = app.emit("native-loading", &model_id);
    let rt = native_inference::NativeRuntime::load(model_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let mut g = state.lock().await;
    *g = Some(rt);
    let _ = app.emit("native-loaded", &model_id);
    Ok(())
}

#[tauri::command]
pub async fn native_unload_model(state: tauri::State<'_, NativeHandle>) -> Result<(), String> {
    let mut g = state.lock().await;
    *g = None;
    Ok(())
}

#[tauri::command]
pub async fn native_current_model(
    state: tauri::State<'_, NativeHandle>,
) -> Result<Option<String>, String> {
    let g = state.lock().await;
    Ok(g.as_ref().map(|r| r.model_id().to_string()))
}

#[derive(serde::Deserialize)]
pub struct NativeChatArgs {
    op_id: String,
    messages: Vec<NativeMsg>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<usize>,
    /// OpenAI-style tool definitions for agent mode. When non-empty the
    /// tool-calling path runs and any calls are emitted via `native-toolcalls`.
    #[serde(default)]
    tools: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct NativeMsg {
    role: String,
    content: String,
    /// Tool calls on an assistant turn (agent mode); forwarded verbatim so
    /// the model sees its own prior calls.
    #[serde(default)]
    tool_calls: Option<serde_json::Value>,
    /// Id linking a `tool` result back to its request (agent mode).
    #[serde(default)]
    tool_call_id: Option<String>,
    /// Display name of a `tool` result's tool (agent mode).
    #[serde(default)]
    name: Option<String>,
}

#[tauri::command]
pub async fn native_chat_stream(
    args: NativeChatArgs,
    state: tauri::State<'_, NativeHandle>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use native_inference::NativeBackend;

    let rt_opt = state.lock().await.clone();
    let rt = rt_opt.ok_or("no model loaded — call native_load_model first")?;
    let op_id = args.op_id.clone();
    let app_for_chunks = app.clone();
    let on_chunk = move |chunk: String| {
        let _ = app_for_chunks.emit(&format!("native-chunk:{op_id}"), chunk);
    };
    let opts = native_inference::SamplingOpts {
        temperature: args.temperature,
        top_p: args.top_p,
        max_tokens: args.max_tokens,
    };
    if args.tools.is_empty() {
        let msgs: Vec<(String, String)> = args
            .messages
            .into_iter()
            .map(|m| (m.role, m.content))
            .collect();
        let final_text = rt
            .chat_stream(msgs, opts, Box::new(on_chunk))
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit(&format!("native-done:{}", args.op_id), &final_text);
        return Ok(final_text);
    }

    // Agent mode: forward OpenAI-style messages so tool_calls / tool results
    // round-trip through the model's chat template.
    let json_msgs: Vec<serde_json::Value> = args
        .messages
        .into_iter()
        .map(|m| {
            let mut obj = serde_json::Map::new();
            obj.insert("role".into(), serde_json::Value::String(m.role));
            obj.insert("content".into(), serde_json::Value::String(m.content));
            if let Some(tc) = m.tool_calls {
                obj.insert("tool_calls".into(), tc);
            }
            if let Some(id) = m.tool_call_id {
                obj.insert("tool_call_id".into(), serde_json::Value::String(id));
            }
            if let Some(name) = m.name {
                obj.insert("name".into(), serde_json::Value::String(name));
            }
            serde_json::Value::Object(obj)
        })
        .collect();
    let turn =
        NativeBackend::chat_stream_tools(&rt, json_msgs, args.tools, opts, Box::new(on_chunk))
            .await
            .map_err(|e| e.to_string())?;
    let _ = app.emit(
        &format!("native-toolcalls:{}", args.op_id),
        &turn.tool_calls,
    );
    let _ = app.emit(&format!("native-done:{}", args.op_id), &turn.content);
    Ok(turn.content)
}

/* ── GGUF file picker (Phase 3 of cross-platform Native rollout) ───────── */

/// Resolve the app's data dir via the Tauri 2 `path()` API. Centralized so
/// the three gguf commands all agree on the parent dir.
fn app_data_dir_for(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir lookup failed: {e}"))
}

#[tauri::command]
pub async fn native_download_gguf(
    repo: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Surface validation errors before kicking off the download so the UI
    // can show a snappy inline error instead of waiting on a network round
    // trip just to fail.
    gguf::validate_repo(&repo).map_err(map_err)?;
    gguf::validate_filename(&filename).map_err(map_err)?;
    let app_data = app_data_dir_for(&app)?;
    let path = gguf::download(app.clone(), app_data, repo, filename)
        .await
        .map_err(map_err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn native_list_gguf_files(app: tauri::AppHandle) -> Result<Vec<gguf::GgufFile>, String> {
    let app_data = app_data_dir_for(&app)?;
    blocking(move || gguf::list_files(&app_data)).await
}

#[tauri::command]
pub async fn native_delete_gguf(
    repo: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    gguf::validate_repo(&repo).map_err(map_err)?;
    gguf::validate_filename(&filename).map_err(map_err)?;
    let app_data = app_data_dir_for(&app)?;
    blocking(move || gguf::delete_file(&app_data, &repo, &filename)).await
}
