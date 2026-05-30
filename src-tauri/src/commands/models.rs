//! Model management: discovery, pulls/deletes, native inference, GGUF files.

use once_cell::sync::Lazy;
use tauri::{Emitter, Manager};

use super::{blocking, map_err, validate_hf_repo, validate_ollama_name, NativeHandle};
use crate::models::ModelEntry;
use crate::{gguf, models, native_inference, ollama_library};

/// Serializes `native_load_model` calls. The heavy `NativeRuntime::load`
/// (a ~10 s `load_model_from_hf`) runs OUTSIDE the `NativeHandle` state
/// lock so reads of the current model stay responsive during a load.
/// But that left a window where two concurrent `native_load_model`
/// calls (a UI click racing an agent-loop dispatch) both ran the full
/// load and then both stored — the first `Arc<NativeRuntime>` dropped
/// the instant the second overwrote it, wasting a multi-GiB GPU load
/// and briefly doubling resident weights. This gate makes loads
/// strictly serial; a second caller waits, then sees the now-current
/// model and short-circuits. Audit HIGH (2026-05-28).
static NATIVE_LOAD_GATE: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

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
    let mut child = cmd.spawn().map_err(|e| format!("{e:#}"))?;

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
    let status = child.wait().await.map_err(|e| format!("{e:#}"))?;
    let cleaned = strip_ansi_and_progress(&String::from_utf8_lossy(&err));
    Ok((status.success(), cleaned))
}

/// Strip ANSI/VT100 escape sequences and carriage-return-driven in-place
/// redraws out of a CLI's captured output. The Ollama and HuggingFace pull
/// CLIs render progress bars with cursor hide/show (`ESC [ ? 25 l`), DEC
/// private-mode toggles (`ESC [ ? 2026 l`), and `\r`-based row rewrites; if
/// they reach the frontend untouched the user sees a wall of mojibake like
/// `[?25l[?2026l pulling manifest [?25h`. Keep only the last `\r`-delimited
/// segment per line so we surface the "final" progress state and trim out
/// the noise.
fn strip_ansi_and_progress(input: &str) -> String {
    // Drop everything from CSI introducer to a final byte in 0x40-0x7E.
    let csi = regex::Regex::new(r"\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]")
        .expect("static CSI regex compiles");
    // Lone ESC, OSC sequences (BEL- or ST-terminated), and other C1 controls.
    let osc =
        regex::Regex::new(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)").expect("static OSC regex compiles");
    let stripped = csi.replace_all(input, "");
    let stripped = osc.replace_all(&stripped, "").to_string();

    // Collapse progress frames to ONE line per logical step.
    //
    // `\r` collapse alone isn't enough: when its stdout is a pipe (not a
    // TTY), `ollama pull` emits each progress tick as a fresh `\n` line
    // rather than a `\r` in-place rewrite — and sometimes runs several
    // "pulling manifest <spinner>" + "pulling <digest>: NN%" frames onto
    // a SINGLE physical line with no separator at all. Left unmerged the
    // user sees a multi-hundred-line wall of near-identical frames
    // (audit 2026-05-29).
    //
    // Strategy: first split the blob on the progress-frame boundary
    // marker "pulling " so run-together frames become separate units,
    // then keep only the LAST frame per logical key:
    //   * `pulling <hex-digest>` frames key on the digest → the final
    //     `…: 100%` (or last-seen %) wins, in first-seen order.
    //   * everything else (manifest spinner, "verifying", "writing
    //     manifest", "success") keys on its trimmed text → de-duped.
    let normalized = stripped
        .replace('\r', "\n")
        // Insert a newline before each "pulling " so concatenated frames
        // split apart. The leading marker itself is preserved.
        .replace("pulling ", "\npulling ");

    let digest_re = regex::Regex::new(r"^pulling ([0-9a-f]{8,})").expect("digest regex compiles");
    // Ordered de-dup: remember insertion order of keys, map key → latest line.
    let mut order: Vec<String> = Vec::new();
    let mut latest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for raw in normalized.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let key = if let Some(c) = digest_re.captures(line) {
            // All frames for one layer share the digest key → final wins.
            format!("digest:{}", &c[1])
        } else {
            line.to_string()
        };
        if !latest.contains_key(&key) {
            order.push(key.clone());
        }
        latest.insert(key, line.to_string());
    }
    order
        .iter()
        .filter_map(|k| latest.get(k))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod strip_tests {
    use super::strip_ansi_and_progress;

    #[test]
    fn strips_ollama_progress_garbage() {
        let raw = "\x1b[?25l\x1b[?2026l\x1b[2026hpulling manifest \r\x1b[K\
                   \x1b[2026hpulling 4c27e0f5b5ad: 50%\r\x1b[K\
                   \x1b[2026hpulling 4c27e0f5b5ad: 100%\n\x1b[?25h";
        let clean = strip_ansi_and_progress(raw);
        assert!(!clean.contains('\x1b'), "still has ESC: {clean:?}");
        assert!(
            clean.contains("pulling 4c27e0f5b5ad: 100%"),
            "lost final line: {clean:?}"
        );
        assert!(
            !clean.contains("50%"),
            "kept superseded frame: {clean:?}"
        );
    }

    #[test]
    fn collapses_run_together_progress_frames() {
        // Non-TTY ollama pull jams many frames onto one line with no
        // separator (the 2026-05-29 wall-of-text bug). All frames for one
        // layer must collapse to the final %.
        let raw = "pulling manifest pulling manifest \
                   pulling 4c27e0f5b5ad: 62% 6.0 GB/9.6 GB \
                   pulling 4c27e0f5b5ad: 63% 6.1 GB/9.6 GB \
                   pulling 4c27e0f5b5ad: 100% 9.6 GB/9.6 GB";
        let clean = strip_ansi_and_progress(raw);
        // Exactly one digest frame survives, and it's the final %.
        let digest_frames = clean
            .lines()
            .filter(|l| l.starts_with("pulling 4c27e0f5b5ad"))
            .count();
        assert_eq!(digest_frames, 1, "expected one collapsed frame: {clean:?}");
        assert!(clean.contains("100%"), "lost final %: {clean:?}");
        assert!(!clean.contains("62%") && !clean.contains("63%"), "kept superseded: {clean:?}");
        // The manifest spinner de-dups to a single line too.
        let manifest = clean.lines().filter(|l| l.trim() == "pulling manifest").count();
        assert!(manifest <= 1, "manifest not de-duped: {clean:?}");
    }

    #[test]
    fn preserves_multiple_distinct_layers() {
        // A real multi-layer pull: each distinct digest keeps its own
        // final frame, in first-seen order.
        let raw = "pulling aaaaaaaa1111: 100% pulling bbbbbbbb2222: 50% \
                   pulling bbbbbbbb2222: 100% pulling manifest success";
        let clean = strip_ansi_and_progress(raw);
        assert!(clean.contains("aaaaaaaa1111: 100%"), "{clean:?}");
        assert!(clean.contains("bbbbbbbb2222: 100%"), "{clean:?}");
        assert!(!clean.contains("50%"), "{clean:?}");
        assert!(clean.contains("success"), "{clean:?}");
    }
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
    // Serialize loads (HIGH 2026-05-28). Held across the whole load so a
    // second concurrent caller waits here rather than kicking off a
    // duplicate multi-GiB load.
    let _load_gate = NATIVE_LOAD_GATE.lock().await;

    // Dedup: if the requested model is already resident (a prior load
    // that we were queued behind just finished it, or it was never
    // unloaded), skip the reload entirely and re-broadcast `loaded`.
    {
        let g = state.lock().await;
        if g.as_ref().map(|rt| rt.model_id() == model_id).unwrap_or(false) {
            let _ = app.emit("native-loaded", &model_id);
            return Ok(());
        }
    }

    let _ = app.emit("native-loading", &model_id);
    let rt = match native_inference::NativeRuntime::load(model_id.clone()).await {
        Ok(rt) => rt,
        Err(e) => {
            // Emit `native-error` so the frontend's loading spinner stops.
            // Previously `native-loading` was emitted but no terminating
            // event fired on failure — the UI sat in 'Loading' forever
            // and a subsequent retry that succeeded confused the state
            // machine because both `native-loading` (old) and
            // `native-loaded` (new) were in flight.
            let msg = e.to_string();
            let _ = app.emit(
                "native-error",
                serde_json::json!({ "model": model_id, "error": msg }),
            );
            return Err(msg);
        }
    };
    // Store under the state lock, then DROP the guard before emitting so
    // a frontend listener reacting to `native-loaded` reads a settled
    // state, never the in-flight guard (ghost-state race, audit MED).
    {
        let mut g = state.lock().await;
        *g = Some(rt);
    }
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
    // Register a cancel token so `native_cancel(op_id)` can stop the stream
    // mid-flight (otherwise the model runs to max_tokens after a user Stop /
    // navigate-away). RAII guard releases the registry entry on every exit
    // path INCLUDING a panic. (2026-05-30)
    let cancel_guard = crate::stream_cancel::CancelGuard::new(&args.op_id);
    let cancel = cancel_guard.token();
    let outcome: Result<String, String> = if args.tools.is_empty() {
        let msgs: Vec<(String, String)> = args
            .messages
            .into_iter()
            .map(|m| (m.role, m.content))
            .collect();
        match rt.chat_stream(msgs, opts, Box::new(on_chunk), cancel.clone()).await {
            Ok(final_text) => {
                let _ = app.emit(&format!("native-done:{}", args.op_id), &final_text);
                Ok(final_text)
            }
            Err(e) => Err(format!("{e:#}")),
        }
    } else {
        // Agent mode: forward OpenAI-style messages so tool_calls / tool
        // results round-trip through the model's chat template.
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
        match NativeBackend::chat_stream_tools(
            &rt,
            json_msgs,
            args.tools,
            opts,
            Box::new(on_chunk),
            cancel.clone(),
        )
        .await
        {
            Ok(turn) => {
                let _ = app.emit(&format!("native-toolcalls:{}", args.op_id), &turn.tool_calls);
                let _ = app.emit(&format!("native-done:{}", args.op_id), &turn.content);
                Ok(turn.content)
            }
            Err(e) => Err(format!("{e:#}")),
        }
    };
    drop(cancel_guard); // explicit: releases the registry entry
    outcome
}

/// Cancel an in-flight native chat stream by its `op_id`. Best-effort: returns
/// `true` if a stream was actually pending. The stream loop races this token
/// via `tokio::select!` and returns its partial output promptly. (2026-05-30)
#[tauri::command]
pub fn native_cancel(op_id: String) -> bool {
    crate::stream_cancel::cancel(&op_id)
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
