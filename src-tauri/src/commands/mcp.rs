//! Model Context Protocol server management commands.

use crate::{
    approval,
    commands::agent::{binding_for, ApprovalPayload},
    mcp,
};

#[tauri::command]
pub async fn mcp_start_server(
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    approval: String,
) -> Result<Vec<mcp::ToolDescriptor>, String> {
    // Approval gate (sec review S-C1): spawning an MCP server is arbitrary
    // process execution under the user's session — `command`, `args`, and
    // `env` are all caller-supplied. Without this gate, a compromised
    // renderer (or any path that reaches the IPC) gains user-level RCE.
    //
    // Token is bound to a SHA-256 of (command + args + env keys) so a token
    // approved for one MCP binary cannot be silently reused to spawn a
    // different one within the 60s TTL. Env VALUES are intentionally NOT in
    // the binding — they may legitimately differ session to session
    // (rotating API keys etc.); the capability the user approves is the
    // program + its arg vector + the set of variables it will read.
    let args_vec = args.unwrap_or_default();
    let env_map = env.unwrap_or_default();
    let mut env_keys: Vec<String> = env_map.keys().cloned().collect();
    env_keys.sort(); // canonicalize so the binding is stable across HashMap order
    let payload = ApprovalPayload {
        mcp_command: Some(command.clone()),
        mcp_args: Some(args_vec.clone()),
        mcp_env_keys: Some(env_keys),
        ..Default::default()
    };
    let Some(expected) = binding_for("mcp_start_server", &payload) else {
        return Err("internal: mcp_start_server binding missing".into());
    };
    if !approval::consume_with_binding("mcp_start_server", &approval, &expected) {
        return Err("tool approval required or expired".into());
    }
    mcp::start_server(name, command, args_vec, Some(env_map))
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
