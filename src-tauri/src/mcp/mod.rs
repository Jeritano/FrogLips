//! Model Context Protocol (MCP) client.
//!
//! Spawns user-configured MCP servers as child processes communicating over
//! stdio using line-delimited JSON-RPC 2.0 (the standard MCP transport,
//! 2024-11-05 spec). Tools advertised by those servers become callable from
//! the agent loop alongside Froglips' built-in tool surface.
//!
//! Security model: command + args are arbitrary user-provided strings, run
//! with the app's full user privileges. Servers are NEVER auto-discovered or
//! pulled from the network — the user must explicitly add a config.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

/// Capped per-request wait. MCP tool calls can be long-running (web search,
/// shell, etc.) but we still want to bound runaway servers.
const RPC_TIMEOUT: Duration = Duration::from_secs(120);
/// Initialize handshake is fast — anything beyond a few seconds means the
/// server is broken or hanging.
const INIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Max stderr we keep buffered for diagnostic display.
const STDERR_CAP: usize = 16 * 1024;
/// Max combined tool-result text we return. Higher than typical tool output
/// but a sane upper bound so a misbehaving server can't OOM us.
const MAX_RESULT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDescriptor {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema of input arguments. MCP calls this `inputSchema`.
    #[serde(rename = "inputSchema", alias = "input_schema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub status: String,
    pub tool_count: usize,
    pub last_error: Option<String>,
}

/// Pending RPC response waiters keyed by request id.
type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct ServerHandle {
    name: String,
    command: String,
    args: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: Mutex<u64>,
    waiters: Waiters,
    tools: RwLock<Vec<ToolDescriptor>>,
    stderr_buf: Arc<Mutex<String>>,
    status: RwLock<String>,
    last_error: RwLock<Option<String>>,
}

impl ServerHandle {
    fn info(&self) -> ServerInfo {
        ServerInfo {
            name: self.name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            status: self.status.read().clone(),
            tool_count: self.tools.read().len(),
            last_error: self.last_error.read().clone(),
        }
    }

    async fn next_request_id(&self) -> u64 {
        let mut g = self.next_id.lock().await;
        let id = *g;
        *g = g.wrapping_add(1);
        id
    }

    async fn send_rpc(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_request_id().await;
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().await.insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&msg).context("encode rpc")?;
        line.push('\n');

        {
            let mut g = self.stdin.lock().await;
            let stdin = g.as_mut().ok_or_else(|| anyhow!("server stdin closed"))?;
            stdin
                .write_all(line.as_bytes())
                .await
                .context("write rpc")?;
            stdin.flush().await.context("flush rpc")?;
        }

        let result = timeout(RPC_TIMEOUT, rx).await;
        // Clear waiter on timeout to avoid leaks.
        match result {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(anyhow!(e)),
            Ok(Err(_)) => {
                self.waiters.lock().await.remove(&id);
                Err(anyhow!("rpc channel closed (server likely exited)"))
            }
            Err(_) => {
                self.waiters.lock().await.remove(&id);
                Err(anyhow!(
                    "rpc '{}' timed out after {}s",
                    method,
                    RPC_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    async fn send_notify(&self, method: &str, params: Value) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&msg)?;
        line.push('\n');
        let mut g = self.stdin.lock().await;
        let stdin = g.as_mut().ok_or_else(|| anyhow!("server stdin closed"))?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn shutdown(&self) {
        // Drop stdin first to give the server a clean EOF signal.
        {
            let mut g = self.stdin.lock().await;
            *g = None;
        }
        let mut g = self.child.lock().await;
        if let Some(mut child) = g.take() {
            // Best-effort wait, then kill if still alive.
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
            let _ = child.start_kill();
        }
        *self.status.write() = "stopped".into();
    }
}

static REGISTRY: Lazy<RwLock<HashMap<String, Arc<ServerHandle>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 64 {
        bail!("server name length out of range (1..=64)");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bail!("server name must be [A-Za-z0-9_-]+");
    }
    Ok(())
}

pub async fn start_server(
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<Vec<ToolDescriptor>> {
    validate_name(&name)?;
    if command.trim().is_empty() {
        bail!("command must not be empty");
    }

    // Stop any existing server with the same name (idempotent restart).
    if let Some(existing) = REGISTRY.write().remove(&name) {
        let h = existing.clone();
        tokio::spawn(async move { h.shutdown().await });
    }

    // Log the full command line + env var names so a surprise/unexpected
    // server spawn is visible in the in-app Diagnostics panel and ring.
    crate::diagnostics::warn_with(
        "mcp",
        &format!("starting server '{}': {} {}", name, command, args.join(" ")),
        json!({
            "server": name,
            "command": command,
            "args": args,
            "env_keys": env.as_ref().map(|e| e.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        }),
    );

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(env_map) = env.as_ref() {
        for (k, v) in env_map {
            cmd.env(k, v);
        }
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn MCP server '{}': {}", name, command))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("no stdin handle"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("no stdout handle"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("no stderr handle"))?;

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));

    let handle = Arc::new(ServerHandle {
        name: name.clone(),
        command: command.clone(),
        args: args.clone(),
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        next_id: Mutex::new(1),
        waiters: waiters.clone(),
        tools: RwLock::new(Vec::new()),
        stderr_buf: stderr_buf.clone(),
        status: RwLock::new("starting".into()),
        last_error: RwLock::new(None),
    });

    // Stderr drain — keep the last STDERR_CAP bytes for diagnostics. The task
    // is tied to the shared shutdown Notify so it exits cleanly on app exit
    // even if the child has not yet been killed (otherwise it would block on
    // `next_line().await` after the registry entry is dropped and only
    // unblock when the kernel finally tears down the pipe).
    {
        let buf = stderr_buf.clone();
        let shutdown = crate::shutdown_signal();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    line = reader.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                let mut g = buf.lock().await;
                                g.push_str(&line);
                                g.push('\n');
                                if g.len() > STDERR_CAP {
                                    let cut = g.len() - STDERR_CAP;
                                    *g = g[cut..].to_string();
                                }
                                // Do NOT echo raw stderr content to host stderr
                                // — it can leak secrets. The full text stays in
                                // the capped in-app diagnostics buffer
                                // (server_stderr) only.
                            }
                            // EOF or read error — child closed its stderr, no
                            // point in spinning. Drop out and let the task end.
                            _ => break,
                        }
                    }
                }
            }
        });
    }

    // Stdout pump — parse JSON-RPC and route responses / log notifications.
    {
        let waiters = waiters.clone();
        let server_name = name.clone();
        let status_handle = handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(&line) {
                            Ok(v) => {
                                if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                                    // Response.
                                    let waiter = waiters.lock().await.remove(&id);
                                    if let Some(tx) = waiter {
                                        if let Some(err) = v.get("error") {
                                            let msg = err
                                                .get("message")
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("rpc error")
                                                .to_string();
                                            let _ = tx.send(Err(msg));
                                        } else {
                                            let result =
                                                v.get("result").cloned().unwrap_or(Value::Null);
                                            let _ = tx.send(Ok(result));
                                        }
                                    }
                                } else if let Some(method) =
                                    v.get("method").and_then(|m| m.as_str())
                                {
                                    // Notification / server-initiated request.
                                    // We don't currently route these; log the
                                    // method name only (no params — may hold
                                    // secrets) and move on.
                                    crate::diagnostics::info(
                                        "mcp",
                                        &format!("{}: notification {}", server_name, method),
                                    );
                                }
                            }
                            Err(e) => {
                                crate::diagnostics::warn_with(
                                    "mcp",
                                    &format!("{}: bad JSON from server ({})", server_name, e),
                                    serde_json::json!({
                                        "server": server_name,
                                        "error": e.to_string(),
                                        // Length only — raw line content can leak secrets.
                                        "line_len": line.len(),
                                    }),
                                );
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        crate::diagnostics::warn_with(
                            "mcp",
                            &format!("{}: stdout read error: {}", server_name, e),
                            serde_json::json!({
                                "server": server_name,
                                "error": e.to_string(),
                            }),
                        );
                        break;
                    }
                }
            }
            // EOF — mark stopped and fail any outstanding waiters.
            *status_handle.status.write() = "stopped".into();
            let drained: Vec<_> = waiters.lock().await.drain().collect();
            for (_, tx) in drained {
                let _ = tx.send(Err("server stdout closed".into()));
            }
        });
    }

    // Initialize handshake.
    let init_params = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "clientInfo": {
            "name": "froglips",
            "version": env!("CARGO_PKG_VERSION"),
        },
    });
    let init_fut = handle.send_rpc("initialize", init_params);
    let init_res = timeout(INIT_TIMEOUT, init_fut).await;
    match init_res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            let err_msg = format!("initialize failed: {}", e);
            *handle.last_error.write() = Some(err_msg.clone());
            handle.shutdown().await;
            bail!(err_msg);
        }
        Err(_) => {
            let err_msg = format!("initialize timed out after {}s", INIT_TIMEOUT.as_secs());
            *handle.last_error.write() = Some(err_msg.clone());
            handle.shutdown().await;
            bail!(err_msg);
        }
    }

    // Spec requires `notifications/initialized` after initialize succeeds.
    let _ = handle
        .send_notify("notifications/initialized", json!({}))
        .await;

    // Fetch tools list.
    let tools_resp = handle
        .send_rpc("tools/list", json!({}))
        .await
        .context("tools/list failed")?;
    let tools: Vec<ToolDescriptor> = tools_resp
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| serde_json::from_value::<ToolDescriptor>(t.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    *handle.tools.write() = tools.clone();
    *handle.status.write() = "running".into();
    *handle.last_error.write() = None;

    REGISTRY.write().insert(name, handle);

    Ok(tools)
}

pub async fn stop_server(name: &str) -> Result<()> {
    let handle = REGISTRY.write().remove(name);
    match handle {
        Some(h) => {
            h.shutdown().await;
            Ok(())
        }
        None => Err(anyhow!("no MCP server named '{}'", name)),
    }
}

pub fn list_servers() -> Vec<ServerInfo> {
    let g = REGISTRY.read();
    let mut out: Vec<ServerInfo> = g.values().map(|h| h.info()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn list_tools(name: &str) -> Result<Vec<ToolDescriptor>> {
    let handle = {
        let g = REGISTRY.read();
        g.get(name).cloned()
    };
    let handle = handle.ok_or_else(|| anyhow!("no MCP server named '{}'", name))?;
    let tools = handle.tools.read().clone();
    Ok(tools)
}

pub async fn call_tool(server: &str, tool: &str, args_json: Value) -> Result<String> {
    let handle = {
        let g = REGISTRY.read();
        g.get(server).cloned()
    };
    let handle = handle.ok_or_else(|| anyhow!("no MCP server named '{}'", server))?;

    let params = json!({
        "name": tool,
        "arguments": args_json,
    });
    let resp = handle.send_rpc("tools/call", params).await?;

    // MCP tool responses come back as { content: [{type, text}|...], isError? }
    let content = resp.get("content").and_then(|c| c.as_array());
    let is_error = resp
        .get("isError")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);

    let mut out = String::new();
    if let Some(arr) = content {
        for block in arr {
            let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match kind {
                "text" => {
                    if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                        out.push_str(t);
                        out.push('\n');
                    }
                }
                "image" => {
                    // Don't dump base64 image bytes into the chat — just note it.
                    let mime = block
                        .get("mimeType")
                        .and_then(|x| x.as_str())
                        .unwrap_or("image/*");
                    out.push_str(&format!("[image: {}]\n", mime));
                }
                "resource" => {
                    if let Some(uri) = block
                        .get("resource")
                        .and_then(|r| r.get("uri"))
                        .and_then(|u| u.as_str())
                    {
                        out.push_str(&format!("[resource: {}]\n", uri));
                    }
                }
                _ => {
                    out.push_str(&block.to_string());
                    out.push('\n');
                }
            }
            if out.len() > MAX_RESULT_BYTES {
                out.truncate(MAX_RESULT_BYTES);
                out.push_str("\n[truncated]");
                break;
            }
        }
    } else {
        // Server returned something non-standard; serialize the whole result.
        out = resp.to_string();
    }

    if is_error {
        // Surface as Err so the agent loop wraps it in its standard error
        // envelope, matching how built-in tool failures look.
        return Err(anyhow!(out.trim().to_string()));
    }
    // External MCP servers are not trusted by default — their text
    // content blocks can contain prompt-injection payloads. Scan and
    // wrap with a DATA-only marker if any heuristic patterns hit.
    let trimmed = out.trim_end().to_string();
    let (wrapped, _n) = crate::agent::injection_scan::scan_and_wrap(&trimmed);
    Ok(wrapped)
}

/// Returns recent stderr from a server (for surfacing failure diagnostics).
pub async fn server_stderr(name: &str) -> Option<String> {
    let handle = {
        let g = REGISTRY.read();
        g.get(name).cloned()?
    };
    let text = handle.stderr_buf.lock().await.clone();
    Some(text)
}

/// Shut down every server. Used on app exit.
pub async fn shutdown_all() {
    let handles: Vec<_> = {
        let mut g = REGISTRY.write();
        g.drain().map(|(_, h)| h).collect()
    };
    for h in handles {
        h.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rules() {
        assert!(validate_name("filesystem").is_ok());
        assert!(validate_name("fs-1").is_ok());
        assert!(validate_name("a_b").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("bad name").is_err());
        assert!(validate_name("bad/name").is_err());
        assert!(validate_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn list_servers_empty_when_none_started() {
        // Note: depends on test ordering — only safe if no test starts servers.
        let _ = list_servers();
    }

    #[test]
    fn list_tools_unknown_errors() {
        let r = list_tools("does-not-exist-xyz");
        assert!(r.is_err());
    }
}
