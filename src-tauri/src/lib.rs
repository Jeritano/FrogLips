mod agent;
mod agent_audit;
mod ask_user;
mod backend_process;
mod commands;
mod crash_log;
mod diagnostics;
mod gguf;
mod history;
mod mcp;
mod memory;
mod models;
mod native_inference;
mod ollama_library;
mod policy;
mod quick_prompt;
mod rag;
mod settings;
mod task_queue;
mod util;

use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

use backend_process::ServerState;
use commands::{NativeHandle, ServerHandle};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn ensure_path_for_gui() {
    // GUI apps launched from Finder/Dock get minimal PATH — extend so `ollama`,
    // `mlx_lm.server`, and other CLI tools installed in common dirs are findable.
    let extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
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
    // Install the process-global panic hook before anything else so panics
    // during startup are captured. Covers all threads, including Tokio workers.
    crash_log::install();

    ensure_path_for_gui();

    // Restore persisted workspace root, if any
    let persisted = settings::load();
    if let Some(ws) = persisted.workspace_root.clone() {
        let _ = agent::set_workspace_root(Some(ws));
    }

    // Auto-start configured MCP servers in the background. Failures are
    // logged but never block app launch — the app must boot even with zero
    // MCP servers configured or every one of them broken.
    let configured_mcp = persisted.mcp_servers.clone().unwrap_or_default();
    if !configured_mcp.is_empty() {
        tauri::async_runtime::spawn(async move {
            for cfg in configured_mcp {
                if !cfg.enabled {
                    continue;
                }
                let name = cfg.name.clone();
                let env_opt = if cfg.env.is_empty() {
                    None
                } else {
                    Some(cfg.env)
                };
                if let Err(e) = mcp::start_server(cfg.name, cfg.command, cfg.args, env_opt).await {
                    diagnostics::warn_with(
                        "mcp",
                        &format!("auto-start '{}' failed: {}", name, e),
                        serde_json::json!({ "server": name, "error": e.to_string() }),
                    );
                }
            }
        });
    }

    let server_state: ServerHandle = Arc::new(ServerState::default());
    let native_state: NativeHandle = native_inference::new_shared();

    // Global-shortcut plugin: Cmd+Shift+L toggles the quick-prompt window.
    // The handler closure receives the AppHandle, so we wake the window
    // without needing extra shared state.
    let global_shortcut_plugin = {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
        let quick_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyL);
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &quick_shortcut && event.state() == ShortcutState::Pressed {
                    quick_prompt::toggle_window(app);
                }
            })
            .build()
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_shortcut_plugin)
        .manage(server_state.clone())
        .manage(native_state.clone())
        .setup({
            let state = server_state.clone();
            move |app| {
                state.set_app(app.handle().clone());
                // Make the AppHandle available to the diagnostics bridge so
                // background tasks (MCP, RAG, agent workers) can emit
                // `app-diagnostics` events without threading a handle
                // through every call site.
                diagnostics::set_app_handle(app.handle().clone());
                let s = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let _ = s.status().await; // emits if child died
                    }
                });

                // Register the default Cmd+Shift+L hotkey. Failure is logged
                // but non-fatal — the tray menu "Quick Prompt" entry still
                // opens the window.
                {
                    use tauri_plugin_global_shortcut::{
                        Code, GlobalShortcutExt, Modifiers, Shortcut,
                    };
                    let sc = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyL);
                    if let Err(e) = app.global_shortcut().register(sc) {
                        eprintln!("[quick-prompt] failed to register Cmd+Shift+L: {e}");
                    }
                }

                let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quick_i =
                    MenuItem::with_id(app, "quick", "Quick Prompt (⇧⌘L)", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quick_i, &quit_i])?;
                let mut tray = TrayIconBuilder::new().menu(&menu);
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quick" => {
                        quick_prompt::toggle_window(app);
                    }
                    _ => {}
                })
                .build(app)?;
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::server_status,
            commands::models::list_all_models,
            commands::models::pull_ollama_model,
            commands::models::pull_hf_model,
            commands::models::ollama_library_fetch,
            commands::models::delete_ollama_model,
            commands::models::delete_mlx_model,
            commands::misc::open_external,
            commands::history::list_conversations,
            commands::history::create_conversation,
            commands::history::delete_conversation,
            commands::history::rename_conversation,
            commands::history::list_messages,
            commands::history::add_message,
            commands::history::delete_message,
            commands::history::conversation_fork,
            commands::history::conversation_list_branches,
            commands::history::conversation_fork_tree,
            commands::memory::add_memory,
            commands::memory::list_memories,
            commands::memory::delete_memory,
            commands::memory::update_memory_status,
            commands::memory::touch_memory,
            commands::memory::touch_memories,
            commands::memory::search_memories_keyword,
            commands::memory::search_memories_vector,
            commands::memory::find_duplicate_memory,
            commands::memory::memory_promote,
            commands::memory::memory_demote,
            commands::memory::memory_set_context,
            commands::agent::agent_read_file,
            commands::agent::agent_list_dir,
            commands::agent::agent_run_shell,
            commands::agent::agent_write_file,
            commands::agent::agent_edit_file,
            commands::agent::agent_file_exists,
            commands::agent::agent_search_files,
            commands::agent::agent_classify_shell,
            commands::agent::agent_classify_applescript,
            commands::agent::agent_classify_http,
            commands::agent::agent_set_workspace,
            commands::agent::agent_get_workspace,
            commands::misc::open_conversation_window,
            commands::misc::list_open_conversation_windows,
            commands::agent::agent_cancel_shell,
            commands::agent::agent_multi_edit,
            commands::agent::agent_git_status,
            commands::agent::agent_git_diff,
            commands::agent::agent_git_log,
            commands::agent::agent_git_show,
            commands::agent::agent_git_branches,
            commands::agent::agent_git_commit,
            commands::agent::agent_web_fetch,
            commands::agent::agent_web_search,
            commands::agent::agent_read_pdf,
            commands::agent::agent_screenshot,
            commands::agent::agent_clipboard_get,
            commands::agent::agent_clipboard_set,
            commands::agent::agent_open_app,
            commands::agent::agent_show_notification,
            commands::agent::agent_open_path_in_editor,
            commands::agent::agent_applescript_run,
            commands::agent::agent_http_request,
            commands::agent::agent_find_definition,
            commands::agent::agent_find_references,
            commands::agent::agent_format_code,
            commands::agent::agent_browser_navigate,
            commands::agent::agent_browser_click,
            commands::agent::agent_browser_fill,
            commands::agent::agent_browser_screenshot,
            commands::agent::agent_browser_get_text,
            commands::agent::agent_browser_close,
            commands::agent::agent_watch_path,
            commands::agent::agent_list_watches,
            commands::agent::agent_poll_watch,
            commands::agent::agent_stop_watch,
            commands::agent::task_create,
            commands::agent::task_status,
            commands::agent::task_list,
            commands::agent::task_cancel,
            commands::agent::task_prune,
            commands::agent::agent_ask_user,
            commands::agent::agent_ask_user_reply,
            commands::agent::agent_ask_user_cancel,
            commands::misc::settings_get,
            commands::misc::settings_set,
            commands::misc::setup_complete_get,
            commands::misc::setup_complete_set,
            commands::server::mlx_probe,
            commands::server::ollama_probe,
            commands::models::native_supported,
            commands::models::native_load_model,
            commands::models::native_unload_model,
            commands::models::native_current_model,
            commands::models::native_chat_stream,
            commands::models::native_download_gguf,
            commands::models::native_list_gguf_files,
            commands::models::native_delete_gguf,
            commands::mcp::mcp_start_server,
            commands::mcp::mcp_stop_server,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_server_stderr,
            commands::agent::policy_load,
            commands::agent::policy_evaluate_shell,
            commands::agent::policy_evaluate_write,
            commands::agent::agent_audit_record,
            commands::agent::agent_audit_list,
            commands::agent::agent_audit_purge,
            commands::agent::agent_audit_stats,
            commands::agent::agent_session_metrics_record,
            commands::agent::agent_session_metrics_query,
            commands::agent::agent_dashboard_summary,
            commands::agent::rag_ingest_folder,
            commands::agent::rag_search,
            commands::agent::rag_list_corpora,
            commands::agent::rag_delete_corpus,
            commands::misc::quick_prompt_submit,
            commands::misc::quick_prompt_open,
            commands::misc::quick_prompt_hide,
            commands::misc::read_crash_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // kill_on_drop on the child handles teardown; this is belt-and-suspenders
    let cleanup = server_state.clone();
    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let s = cleanup.clone();
            tauri::async_runtime::block_on(async move {
                // Bound the whole teardown so a wedged child/MCP server can't
                // hang app exit indefinitely.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(8), async move {
                    s.stop().await;
                    mcp::shutdown_all().await;
                    agent::browser::shutdown().await;
                })
                .await;
            });
            agent::fs_watcher::shutdown_all();
        }
    });
}
