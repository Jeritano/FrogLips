mod agent;
mod history;
mod memory;
mod mlx_server;
mod models;

use once_cell::sync::Lazy;
use regex::Regex;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tauri_plugin_opener::OpenerExt;

use mlx_server::{ServerState, ServerStatus};
use models::ModelEntry;

type ServerHandle = Arc<ServerState>;

/* ── Input limits ── */
const MAX_MESSAGE_BYTES: usize = 1_048_576; // 1 MiB
const MAX_MEMORY_BYTES: usize = 16_384;     // 16 KiB
const MAX_TITLE_LEN: usize = 200;
const MAX_TAGS_LEN: usize = 256;
const MAX_QUERY_LEN: usize = 256;
const MAX_EMBEDDING_DIMS: usize = 4096;

/* ── Validators ── */
static OLLAMA_MODEL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9._:@/-]+$").unwrap());
static HF_REPO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap());

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn validate_ollama_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 256 {
        return Err("ollama model name length out of range".into());
    }
    if name.starts_with('-') {
        return Err("ollama model name must not start with '-'".into());
    }
    if name.contains("..") {
        return Err("ollama model name must not contain '..'".into());
    }
    if !OLLAMA_MODEL_RE.is_match(name) {
        return Err("ollama model name has illegal characters".into());
    }
    Ok(())
}

fn validate_hf_repo(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        return Err("HF repo id length out of range".into());
    }
    if id.starts_with('-') || id.contains("..") {
        return Err("HF repo id must not start with '-' or contain '..'".into());
    }
    if !HF_REPO_RE.is_match(id) {
        return Err("HF repo id must match org/name".into());
    }
    // Each segment must contain at least one alphanumeric (rules out names like "./.")
    for seg in id.split('/') {
        if !seg.chars().any(|c| c.is_ascii_alphanumeric()) {
            return Err("HF repo id segments must contain alphanumerics".into());
        }
    }
    Ok(())
}

#[tauri::command]
async fn start_server(
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
    let status = state.start(model, backend).await.map_err(map_err)?;
    let _ = app.emit("server-status", &status);
    Ok(status)
}

#[tauri::command]
async fn stop_server(state: State<'_, ServerHandle>, app: tauri::AppHandle) -> Result<(), String> {
    state.stop().await;
    let _ = app.emit("server-status", &state.status().await);
    Ok(())
}

#[tauri::command]
async fn server_status(state: State<'_, ServerHandle>) -> Result<ServerStatus, String> {
    Ok(state.status().await)
}

#[derive(serde::Serialize)]
struct AllModels {
    mlx: Vec<ModelEntry>,
    ollama: Vec<ModelEntry>,
    mlx_error: Option<String>,
    ollama_error: Option<String>,
}

#[tauri::command]
async fn list_all_models() -> Result<AllModels, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let lists = models::list_all_models().map_err(map_err)?;
        Ok(AllModels {
            mlx: lists.mlx,
            ollama: lists.ollama,
            mlx_error: lists.mlx_error,
            ollama_error: lists.ollama_error,
        })
    })
    .await
    .map_err(map_err)?
}

#[tauri::command]
async fn pull_ollama_model(name: String) -> Result<String, String> {
    validate_ollama_name(&name)?;
    const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);
    let fut = tokio::process::Command::new("ollama")
        .arg("pull")
        .arg("--")
        .arg(&name)
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(PULL_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs())),
    };
    if output.status.success() {
        Ok(format!("Pulled {name}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[tauri::command]
fn open_external(url: String, app: tauri::AppHandle) -> Result<(), String> {
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
        "civitai.com" | "www.civitai.com" |
        "huggingface.co" | "www.huggingface.co" |
        "ollama.com" | "www.ollama.com"
    );
    if !allowed {
        return Err(format!("host not allowed: {host}"));
    }
    // Use Apple's LaunchServices via tauri-plugin-opener (no exec) — avoids
    // argv-injection risk of shelling out to /usr/bin/open with the URL.
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(map_err)
}

#[tauri::command]
async fn pull_hf_model(repo_id: String) -> Result<String, String> {
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
        // child download is also killed instead of leaking and burning bandwidth.
        let fut = tokio::process::Command::new(&bin)
            .arg(sub)
            .arg("--")
            .arg(&repo_id)
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(PULL_TIMEOUT, fut).await {
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if output.status.success() && !stderr.contains("deprecated and no longer works") {
                    return Ok(format!("Downloaded {repo_id}"));
                }
                last_err = stderr.into_owned();
            }
            Ok(Err(e)) => {
                last_err = e.to_string();
            }
            Err(_) => {
                return Err(format!("pull timed out after {}s", PULL_TIMEOUT.as_secs()));
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn list_conversations() -> Result<Vec<history::Conversation>, String> {
    tauri::async_runtime::spawn_blocking(history::list_conversations)
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn create_conversation(title: String, model: Option<String>) -> Result<i64, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        history::create_conversation(&title, model.as_deref())
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn delete_conversation(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || history::delete_conversation(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn rename_conversation(id: i64, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".into());
    }
    if trimmed.len() > MAX_TITLE_LEN {
        return Err(format!("title exceeds {MAX_TITLE_LEN} chars"));
    }
    let title = trimmed.to_string();
    tauri::async_runtime::spawn_blocking(move || history::rename_conversation(id, &title))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn list_messages(conversation_id: i64) -> Result<Vec<history::Message>, String> {
    tauri::async_runtime::spawn_blocking(move || history::list_messages(conversation_id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn add_message(
    conversation_id: i64,
    role: String,
    content: String,
    model: Option<String>,
) -> Result<i64, String> {
    if content.len() > MAX_MESSAGE_BYTES {
        return Err(format!("message exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    if !matches!(role.as_str(), "system" | "user" | "assistant") {
        return Err(format!("invalid role: {role}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        history::add_message(conversation_id, &role, &content, model.as_deref())
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

/* ── Memory ── */

#[tauri::command]
async fn add_memory(
    content: String,
    conversation_id: Option<i64>,
    source_msg_id: Option<i64>,
    tags: Option<String>,
    embedding: Option<Vec<f32>>,
    status: Option<String>,
) -> Result<i64, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("memory content empty".into());
    }
    if trimmed.len() > MAX_MEMORY_BYTES {
        return Err(format!("memory exceeds {MAX_MEMORY_BYTES} bytes"));
    }
    let st = status.as_deref().unwrap_or("active").to_string();
    if !matches!(st.as_str(), "active" | "pending" | "archived") {
        return Err(format!("invalid status: {st}"));
    }
    let tags_s = tags.unwrap_or_default();
    if tags_s.len() > MAX_TAGS_LEN {
        return Err(format!("tags exceed {MAX_TAGS_LEN} chars"));
    }
    if tags_s.contains('\n') || tags_s.contains('\r') {
        return Err("tags must not contain newlines".into());
    }
    if let Some(emb) = &embedding {
        if emb.len() > MAX_EMBEDDING_DIMS {
            return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
        }
    }
    let content = trimmed.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        memory::add_memory(
            &content,
            conversation_id,
            source_msg_id,
            &tags_s,
            embedding,
            &st,
        )
    })
    .await
    .map_err(map_err)?
    .map_err(map_err)
}

#[tauri::command]
async fn list_memories(status: Option<String>) -> Result<Vec<memory::Memory>, String> {
    tauri::async_runtime::spawn_blocking(move || memory::list_memories(status.as_deref()))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn delete_memory(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::delete_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn update_memory_status(id: i64, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "active" | "pending" | "archived") {
        return Err(format!("invalid status: {status}"));
    }
    tauri::async_runtime::spawn_blocking(move || memory::update_memory_status(id, &status))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn touch_memory(id: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || memory::touch_memory(id))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn touch_memories(ids: Vec<i64>) -> Result<(), String> {
    // SQLite SQLITE_MAX_VARIABLE_NUMBER is 999 on older builds; cap well under
    // that to stay safe even if rusqlite is downgraded.
    if ids.len() > 500 {
        return Err("too many ids (max 500)".into());
    }
    tauri::async_runtime::spawn_blocking(move || memory::touch_memories(&ids))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn search_memories_keyword(
    query: String,
    limit: Option<i64>,
) -> Result<Vec<memory::Memory>, String> {
    if query.len() > MAX_QUERY_LEN {
        return Err(format!("query exceeds {MAX_QUERY_LEN} chars"));
    }
    let limit = limit.unwrap_or(5).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || memory::search_keyword(&query, limit))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn search_memories_vector(
    embedding: Vec<f32>,
    limit: Option<i64>,
    min_score: Option<f32>,
) -> Result<Vec<memory::Memory>, String> {
    if embedding.len() > MAX_EMBEDDING_DIMS {
        return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
    }
    let limit = limit.unwrap_or(5).clamp(1, 50) as usize;
    let min_score = min_score.unwrap_or(0.55);
    tauri::async_runtime::spawn_blocking(move || memory::search_vector(embedding, limit, min_score))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

#[tauri::command]
async fn find_duplicate_memory(
    embedding: Vec<f32>,
    threshold: Option<f32>,
) -> Result<Option<i64>, String> {
    if embedding.len() > MAX_EMBEDDING_DIMS {
        return Err(format!("embedding exceeds {MAX_EMBEDDING_DIMS} dims"));
    }
    let threshold = threshold.unwrap_or(0.85);
    tauri::async_runtime::spawn_blocking(move || memory::find_duplicate(embedding, threshold))
        .await
        .map_err(map_err)?
        .map_err(map_err)
}

/* ── Agent tool commands ── */

#[tauri::command]
async fn agent_read_file(path: String) -> Result<String, String> {
    agent::read_file(path).await
}

#[tauri::command]
async fn agent_list_dir(path: String) -> Result<Vec<agent::DirEntry>, String> {
    agent::list_dir(path).await
}

#[tauri::command]
async fn agent_run_shell(command: String) -> Result<agent::ShellResult, String> {
    agent::run_shell(command).await
}

#[tauri::command]
async fn agent_write_file(path: String, content: String) -> Result<(), String> {
    agent::write_file(path, content).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn ensure_path_for_gui() {
    // GUI apps launched from Finder/Dock get minimal PATH — extend so `ollama`,
    // `mlx_lm.server`, and other CLI tools installed in common dirs are findable.
    let extra = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
    ];
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    if let Some(home) = dirs::home_dir() {
        for sub in [".local/bin", ".cargo/bin", ".venvs/mlx/bin"] {
            let p = home.join(sub).to_string_lossy().into_owned();
            if !parts.contains(&p) {
                parts.push(p);
            }
        }
    }
    for p in extra {
        let s = p.to_string();
        if !parts.contains(&s) {
            parts.push(s);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

pub fn run() {
    ensure_path_for_gui();
    let server_state: ServerHandle = Arc::new(ServerState::default());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(server_state.clone())
        .setup({
            let state = server_state.clone();
            move |app| {
                state.set_app(app.handle().clone());
                let s = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let _ = s.status().await; // emits if child died
                    }
                });
                let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                TrayIconBuilder::new()
                    .menu(&menu)
                    .icon(app.default_window_icon().unwrap().clone())
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .build(app)?;
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            server_status,
            list_all_models,
            pull_ollama_model,
            pull_hf_model,
            open_external,
            list_conversations,
            create_conversation,
            delete_conversation,
            rename_conversation,
            list_messages,
            add_message,
            add_memory,
            list_memories,
            delete_memory,
            update_memory_status,
            touch_memory,
            touch_memories,
            search_memories_keyword,
            search_memories_vector,
            find_duplicate_memory,
            agent_read_file,
            agent_list_dir,
            agent_run_shell,
            agent_write_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // kill_on_drop on the child handles teardown; this is belt-and-suspenders
    let cleanup = server_state.clone();
    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let s = cleanup.clone();
            tauri::async_runtime::block_on(async move { s.stop().await; });
        }
    });
}
