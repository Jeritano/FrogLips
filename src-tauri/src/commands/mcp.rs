//! Model Context Protocol server management commands.

use crate::mcp;

#[tauri::command]
pub async fn mcp_start_server(
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<mcp::ToolDescriptor>, String> {
    let args = args.unwrap_or_default();
    mcp::start_server(name, command, args, env)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_stop_server(name: String) -> Result<(), String> {
    mcp::stop_server(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_list_servers() -> Vec<mcp::ServerInfo> {
    mcp::list_servers()
}

#[tauri::command]
pub fn mcp_list_tools(name: String) -> Result<Vec<mcp::ToolDescriptor>, String> {
    mcp::list_tools(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Option<serde_json::Value>,
) -> Result<String, String> {
    let args = args.unwrap_or(serde_json::json!({}));
    mcp::call_tool(&server, &tool, args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_server_stderr(name: String) -> Option<String> {
    mcp::server_stderr(&name).await
}
