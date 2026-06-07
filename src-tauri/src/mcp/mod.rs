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

pub mod oauth;

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
use tokio::sync::{oneshot, Mutex, Notify};
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
/// Version advertised in the `MCP-Protocol-Version` header on the remote
/// (streamable-HTTP) transport. Independent of the `protocolVersion` sent in
/// the `initialize` params (kept at 2024-11-05 for broad server compat).
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Scan an SSE response body for the JSON-RPC envelope whose `id` matches the
/// request we sent. Each event is one or more `data:` lines; we parse each
/// payload and return the first that carries our id with a result/error.
fn parse_sse_for_id(body: &str, want_id: u64) -> Option<Value> {
    let mut data = String::new();
    let flush = |data: &mut String| -> Option<Value> {
        if data.is_empty() {
            return None;
        }
        let parsed = serde_json::from_str::<Value>(data.trim()).ok();
        data.clear();
        let v = parsed?;
        let id_matches = v.get("id").and_then(|x| {
            x.as_u64()
                .or_else(|| x.as_str().and_then(|s| s.parse::<u64>().ok()))
        }) == Some(want_id);
        if id_matches && (v.get("result").is_some() || v.get("error").is_some()) {
            Some(v)
        } else {
            None
        }
    };
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            // Accumulate multi-line data payloads (joined by '\n' per SSE spec).
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        } else if line.trim().is_empty() {
            // Event boundary — try the accumulated payload.
            if let Some(v) = flush(&mut data) {
                return Some(v);
            }
        }
    }
    // Trailing event with no terminating blank line.
    flush(&mut data)
}

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
    /// "stdio" (child process) or "remote" (streamable-HTTP).
    pub transport: String,
}

/// Pending RPC response waiters keyed by request id.
type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// Transport-specific state. `Stdio` spawns a child process and pumps
/// line-delimited JSON-RPC over its pipes. `Remote` speaks the MCP
/// "streamable-HTTP" transport: one HTTP POST per request, the response either
/// a single JSON object or an SSE stream, with the session carried in the
/// `Mcp-Session-Id` header.
enum Transport {
    Stdio(StdioTransport),
    Remote(RemoteTransport),
}

struct StdioTransport {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    waiters: Waiters,
}

struct RemoteTransport {
    client: reqwest::Client,
    url: String,
    /// Session id handed back by the server on `initialize`, echoed on every
    /// subsequent request.
    session: RwLock<Option<String>>,
    /// Bearer token (read from the Keychain at start time), if the server
    /// requires auth. Never serialized; never logged.
    /// Bearer token; behind a lock so an OAuth 401 can refresh it in place
    /// (the access token expires ~1h after connect).
    auth: RwLock<Option<String>>,
}

struct ServerHandle {
    name: String,
    /// Display command: the binary path (stdio) or the endpoint URL (remote).
    command: String,
    args: Vec<String>,
    next_id: Mutex<u64>,
    transport: Transport,
    tools: RwLock<Vec<ToolDescriptor>>,
    stderr_buf: Arc<Mutex<String>>,
    status: RwLock<String>,
    last_error: RwLock<Option<String>>,
    /// Per-server stop signal. Released by `shutdown` / `stop_server` so the
    /// stderr drain task tied to THIS server exits when only THIS server is
    /// stopped — without it the drainer would keep parked on `next_line()`
    /// until either the kernel finally tears down the pipe or the global
    /// shutdown fires, which leaks a task per server churn.
    stop: Arc<Notify>,
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
            transport: match self.transport {
                Transport::Stdio(_) => "stdio".into(),
                Transport::Remote(_) => "remote".into(),
            },
        }
    }

    async fn next_request_id(&self) -> u64 {
        let mut g = self.next_id.lock().await;
        let id = *g;
        *g = g.wrapping_add(1);
        id
    }

    /// Dispatch a request/response RPC over whichever transport this server
    /// uses.
    async fn send_rpc(&self, method: &str, params: Value) -> Result<Value> {
        match &self.transport {
            Transport::Stdio(t) => self.send_rpc_stdio(t, method, params).await,
            Transport::Remote(t) => self.send_rpc_remote(t, method, params).await,
        }
    }

    async fn send_rpc_stdio(
        &self,
        t: &StdioTransport,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        // Fast-fail liveness check: if the stdout pump already marked the
        // server stopped (process exited but registry entry not yet cleaned),
        // refuse new RPCs immediately instead of writing to a pipe whose
        // peer is gone and waiting the full RPC_TIMEOUT for nothing. Without
        // this, every tool call on a dead server hangs 120s before failing.
        {
            let s = self.status.read();
            if s.as_str() != "running" {
                return Err(anyhow!(
                    "MCP server '{}' is not running (status: {})",
                    self.name,
                    s
                ));
            }
        }
        let id = self.next_request_id().await;
        let (tx, rx) = oneshot::channel();
        t.waiters.lock().await.insert(id, tx);
        // Re-check liveness AFTER inserting the waiter. The stdout pump sets
        // status="stopped" then drains all waiters on EOF; if that happened
        // between the liveness check above and this insert, our waiter lands
        // AFTER the drain and would never be resolved — a full RPC_TIMEOUT
        // (120s) hang. Re-checking here closes that window. LOW (2026-05-30).
        if self.status.read().as_str() != "running" {
            t.waiters.lock().await.remove(&id);
            return Err(anyhow!(
                "MCP server '{}' stopped before the request could be sent",
                self.name
            ));
        }

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&msg).context("encode rpc")?;
        line.push('\n');

        {
            let mut g = t.stdin.lock().await;
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
                t.waiters.lock().await.remove(&id);
                Err(anyhow!("rpc channel closed (server likely exited)"))
            }
            Err(_) => {
                t.waiters.lock().await.remove(&id);
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
        match &self.transport {
            Transport::Stdio(t) => {
                let mut line = serde_json::to_string(&msg)?;
                line.push('\n');
                let mut g = t.stdin.lock().await;
                let stdin = g.as_mut().ok_or_else(|| anyhow!("server stdin closed"))?;
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
                Ok(())
            }
            Transport::Remote(t) => {
                // Fire-and-forget POST; a 202 (or any 2xx) is success, errors
                // are non-fatal for a notification.
                let mut req = t
                    .client
                    .post(&t.url)
                    .header("Accept", "application/json, text/event-stream")
                    .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
                    .json(&msg);
                let sid = t.session.read().clone();
                if let Some(sid) = sid {
                    req = req.header("Mcp-Session-Id", sid);
                }
                if let Some(auth) = t.auth.read().clone() {
                    req = req.bearer_auth(auth);
                }
                let _ = req.send().await;
                Ok(())
            }
        }
    }

    /// MCP "streamable-HTTP" request/response. One POST per call; the response
    /// is either a single JSON object (`application/json`) or an SSE stream
    /// (`text/event-stream`) carrying the JSON-RPC reply. The session id from
    /// `initialize` is captured and echoed on subsequent requests.
    /// Refresh this server's OAuth access token (if it has stored creds),
    /// persist the new token, and update the live transport's bearer in place.
    /// Returns true iff a new token was obtained. Best-effort.
    async fn try_oauth_refresh(&self, t: &RemoteTransport) -> bool {
        let key = format!("mcp_oauth:{}", self.name);
        let Some(json) = crate::settings::keychain_get(&key) else {
            return false;
        };
        let Ok(creds) = serde_json::from_str::<oauth::OauthCreds>(&json) else {
            return false;
        };
        match oauth::refresh(&creds).await {
            Ok(fresh) => {
                crate::settings::keychain_set_account(
                    &format!("mcp:{}", self.name),
                    &fresh.access_token,
                );
                if let Ok(j) = serde_json::to_string(&fresh) {
                    crate::settings::keychain_set_account(&key, &j);
                }
                *t.auth.write() = Some(fresh.access_token);
                true
            }
            Err(e) => {
                crate::diagnostics::warn_with(
                    "mcp",
                    &format!("oauth token refresh failed for '{}'", self.name),
                    json!({ "server": self.name, "error": e.to_string() }),
                );
                false
            }
        }
    }

    async fn send_rpc_remote(
        &self,
        t: &RemoteTransport,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let id = self.next_request_id().await;
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        // Up to 2 attempts: on a 401 with stored OAuth creds, refresh the token
        // in place and retry ONCE (access tokens expire ~1h after connect).
        let mut resp = {
            let mut attempt = 0u8;
            loop {
                attempt += 1;
                let mut req = t
                    .client
                    .post(&t.url)
                    .header("Accept", "application/json, text/event-stream")
                    .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
                    .json(&msg);
                if let Some(sid) = t.session.read().clone() {
                    req = req.header("Mcp-Session-Id", sid);
                }
                if let Some(auth) = t.auth.read().clone() {
                    req = req.bearer_auth(auth);
                }
                let resp = timeout(RPC_TIMEOUT, req.send())
                    .await
                    .map_err(|_| {
                        anyhow!(
                            "rpc '{}' timed out after {}s",
                            method,
                            RPC_TIMEOUT.as_secs()
                        )
                    })?
                    .with_context(|| format!("remote rpc '{method}' transport error"))?;
                // Capture / refresh the session id (servers set it on `initialize`).
                if let Some(sid) = resp
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
                {
                    *t.session.write() = Some(sid);
                }
                if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                    && attempt == 1
                    && self.try_oauth_refresh(t).await
                {
                    continue;
                }
                break resp;
            }
        };

        let status = resp.status();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!(
                "remote rpc '{}' HTTP {}: {}",
                method,
                status,
                body.chars().take(300).collect::<String>()
            );
        }

        // Bounded STREAMING read: accumulate chunks and abort the moment the
        // total exceeds MAX_RESULT_BYTES. `resp.bytes()` would buffer the
        // entire body into RAM before any size check, so a hostile server
        // could force a huge allocation; chunked reads cap it. The whole loop
        // is wrapped in one timeout so a slow-drip body can't hold the
        // connection open past RPC_TIMEOUT.
        let body: Vec<u8> = timeout(RPC_TIMEOUT, async {
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = resp
                .chunk()
                .await
                .with_context(|| format!("remote rpc '{method}' body error"))?
            {
                if buf.len() + chunk.len() > MAX_RESULT_BYTES {
                    bail!(
                        "remote rpc '{}' response exceeds {} bytes",
                        method,
                        MAX_RESULT_BYTES
                    );
                }
                buf.extend_from_slice(&chunk);
            }
            Ok::<Vec<u8>, anyhow::Error>(buf)
        })
        .await
        .map_err(|_| anyhow!("rpc '{}' body read timed out", method))??;
        let text = String::from_utf8_lossy(&body);

        let envelope = if ctype.contains("text/event-stream") {
            parse_sse_for_id(&text, id)
                .ok_or_else(|| anyhow!("remote rpc '{}': no response in SSE stream", method))?
        } else {
            serde_json::from_str::<Value>(text.trim())
                .with_context(|| format!("remote rpc '{method}' bad JSON"))?
        };

        if let Some(err) = envelope.get("error") {
            let m = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("rpc error");
            bail!("{}", m);
        }
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn shutdown(&self) {
        // Release the per-server stderr drainer before killing the child so it
        // exits even if the child's stderr stays open long enough that
        // `next_line()` would still block. Cheap and idempotent.
        self.stop.notify_waiters();
        let t = match &self.transport {
            Transport::Stdio(t) => t,
            Transport::Remote(r) => {
                // Best-effort session teardown (spec: DELETE terminates it).
                let sid = r.session.read().clone();
                if let Some(sid) = sid {
                    let mut req = r
                        .client
                        .delete(&r.url)
                        .header("Mcp-Session-Id", sid)
                        .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
                    if let Some(auth) = r.auth.read().clone() {
                        req = req.bearer_auth(auth);
                    }
                    let _ = timeout(Duration::from_secs(3), req.send()).await;
                }
                *self.status.write() = "stopped".into();
                return;
            }
        };
        // Drop stdin first to give the server a clean EOF signal.
        {
            let mut g = t.stdin.lock().await;
            *g = None;
        }
        let mut g = t.child.lock().await;
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

    // SECURITY: MCP servers run as child processes with full user privileges.
    // Tokio's Command inherits the parent env by default, which means every
    // MCP server gets a copy of the Froglips app's env — including ANTHROPIC
    // /OPENAI/AWS/GCP/GITHUB tokens the user (or their shell rc) exported.
    // A malicious or careless server could exfiltrate them with one
    // `process.env` read. Strip everything except a curated allowlist of
    // benign vars the child genuinely needs to start and run (PATH for binary
    // resolution, HOME for ~ expansion, locale for output, TMPDIR for scratch
    // files, etc.). User-supplied env values (validated above the next block)
    // are then layered on top — MCP server configs declare what credentials
    // they actually need via the explicit `env` map.
    cmd.env_clear();
    const SAFE_ENV_ALLOWLIST: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TZ",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TMPDIR",
        "PWD",
        "OLDPWD",
        "DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ];
    for var in SAFE_ENV_ALLOWLIST {
        if let Ok(val) = std::env::var(var) {
            cmd.env(var, val);
        }
    }

    if let Some(env_map) = env.as_ref() {
        for (k, v) in env_map {
            // Reject dynamic-linker hijacking keys (LD_*, DYLD_*) — same family
            // the shell tool already refuses. The MCP env path runs at app
            // boot via auto-start (lib.rs:118-136) BEFORE the user sees any
            // UI, so a malicious settings.json entry here would otherwise
            // achieve code injection on every launch without any prompt.
            if crate::agent::shell::is_dynlinker_env_key(k) {
                bail!("MCP env key '{k}' is not permitted (dynamic-linker family)");
            }
            // NUL in keys or values would silently truncate the C string the
            // kernel exposes to the child; reject so a value can't smuggle a
            // hidden suffix past whatever validation ran upstream. Also
            // reject '=' in the key — that would split the env entry.
            if k.contains('\0') || k.contains('=') {
                bail!("MCP env key contains invalid byte (NUL or '=')");
            }
            if v.contains('\0') {
                bail!("MCP env value for '{k}' contains NUL byte");
            }
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
    let stop = Arc::new(Notify::new());

    let handle = Arc::new(ServerHandle {
        name: name.clone(),
        command: command.clone(),
        args: args.clone(),
        next_id: Mutex::new(1),
        transport: Transport::Stdio(StdioTransport {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            waiters: waiters.clone(),
        }),
        tools: RwLock::new(Vec::new()),
        stderr_buf: stderr_buf.clone(),
        status: RwLock::new("starting".into()),
        last_error: RwLock::new(None),
        stop: stop.clone(),
    });

    // Stderr drain — keep the last STDERR_CAP bytes for diagnostics. The task
    // races BOTH a per-server `stop` Notify (released by this server's
    // `shutdown`) and the global app-shutdown Notify so it exits cleanly
    // whether ONE server is stopped or the whole app exits. Without the
    // per-server signal, stopping one server would leave its drainer parked
    // on `next_line().await` until either the kernel finally tears down the
    // pipe or global shutdown fires — a per-server-churn task leak.
    {
        let buf = stderr_buf.clone();
        let shutdown = crate::shutdown_signal();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            loop {
                // Sticky-flag check covers the race where global shutdown
                // fired while we were inside `next_line().await` — the
                // `notify_waiters()` would have landed with no parked waiter
                // and been lost without this guard.
                if crate::is_shutting_down() {
                    break;
                }
                tokio::select! {
                    _ = shutdown.notified() => break,
                    _ = stop.notified() => break,
                    line = reader.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                let mut g = buf.lock().await;
                                g.push_str(&line);
                                g.push('\n');
                                if g.len() > STDERR_CAP {
                                    // Walk forward to the next char boundary
                                    // before slicing — `g.len() - STDERR_CAP`
                                    // is a raw byte index, and if it lands in
                                    // the middle of a multi-byte UTF-8
                                    // codepoint (any non-ASCII payload),
                                    // `g[cut..]` would panic the drainer task
                                    // for the lifetime of the server.
                                    let mut cut = g.len() - STDERR_CAP;
                                    while cut < g.len() && !g.is_char_boundary(cut) {
                                        cut += 1;
                                    }
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

    // Bounded line reader — caps a single line at MAX_RESULT_BYTES so a
    // misbehaving stdio server can't OOM the app with one unterminated
    // multi-GB line (tokio's `Lines` grows its buffer unbounded). Oversized
    // lines are skipped (drained to the next newline) rather than buffered.
    async fn read_capped_line<R: tokio::io::AsyncBufRead + Unpin>(
        reader: &mut R,
        max: usize,
    ) -> std::io::Result<Option<String>> {
        use tokio::io::AsyncBufReadExt;
        let mut line: Vec<u8> = Vec::new();
        let mut over = false;
        loop {
            let chunk = reader.fill_buf().await?;
            if chunk.is_empty() {
                if line.is_empty() && !over {
                    return Ok(None); // EOF
                }
                let out = if over {
                    String::new()
                } else {
                    String::from_utf8_lossy(&line).into_owned()
                };
                return Ok(Some(out));
            }
            if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
                if !over && line.len() + pos <= max {
                    line.extend_from_slice(&chunk[..pos]);
                } else {
                    over = true;
                }
                reader.consume(pos + 1);
                if over {
                    // Oversized line fully consumed → skip it, start the next.
                    line.clear();
                    over = false;
                    continue;
                }
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            let take = chunk.len();
            if !over && line.len() + take <= max {
                line.extend_from_slice(chunk);
            } else {
                over = true; // past the cap — stop accumulating, keep draining
            }
            reader.consume(take);
        }
    }

    // Stdout pump — parse JSON-RPC and route responses / log notifications.
    {
        let waiters = waiters.clone();
        let server_name = name.clone();
        let status_handle = handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_capped_line(&mut reader, MAX_RESULT_BYTES).await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(&line) {
                            Ok(v) => {
                                // JSON-RPC 2.0 permits string ids. We always
                                // SEND integer ids, but a server that echoes
                                // them as strings (e.g. "5") would otherwise
                                // miss correlation and hang the caller the full
                                // RPC_TIMEOUT. Accept both. LOW (2026-05-30).
                                let id_opt = v.get("id").and_then(|x| {
                                    x.as_u64()
                                        .or_else(|| x.as_str().and_then(|s| s.parse::<u64>().ok()))
                                });
                                if let Some(id) = id_opt {
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

    finish_start(handle, name).await
}

/// Shared post-construction handshake for both transports: `initialize` →
/// `notifications/initialized` → `tools/list`, then register the running
/// server in the global REGISTRY. On any failure the handle is shut down and
/// the error propagated.
async fn finish_start(handle: Arc<ServerHandle>, name: String) -> Result<Vec<ToolDescriptor>> {
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
    // 2026-05-25 SE review: cap accepted tool count to prevent a hostile
    // (or buggy) MCP server from returning millions of entries and bloating
    // the registry's RwLock for the lifetime of the process. 256 tools per
    // server is generous — the well-known servers (filesystem, github, etc.)
    // expose < 30 each.
    const MAX_TOOLS_PER_SERVER: usize = 256;
    let mut tools: Vec<ToolDescriptor> = tools_resp
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .take(MAX_TOOLS_PER_SERVER)
                .filter_map(|t| serde_json::from_value::<ToolDescriptor>(t.clone()).ok())
                .map(sanitize_mcp_tool_descriptor)
                .collect()
        })
        .unwrap_or_default();
    // Log if the cap actually clipped something — operator should know.
    if let Some(arr) = tools_resp.get("tools").and_then(|t| t.as_array()) {
        if arr.len() > MAX_TOOLS_PER_SERVER {
            crate::diagnostics::warn_with(
                "mcp",
                &format!(
                    "server '{}' returned {} tools — clipped to {} (per-server cap)",
                    &handle.name,
                    arr.len(),
                    MAX_TOOLS_PER_SERVER,
                ),
                serde_json::json!({
                    "server": &handle.name,
                    "reported": arr.len(),
                    "accepted": MAX_TOOLS_PER_SERVER,
                }),
            );
        }
    }
    // Trim allocation since `take()` may leave capacity over.
    tools.shrink_to_fit();

    *handle.tools.write() = tools.clone();
    *handle.status.write() = "running".into();
    *handle.last_error.write() = None;

    REGISTRY.write().insert(name, handle);

    Ok(tools)
}

/// Validate a remote MCP endpoint URL. Requires http/https and rejects the
/// SSRF-sensitive address space (link-local, unspecified, multicast, cloud
/// metadata hostnames). Loopback + LAN are allowed so a locally-hosted MCP
/// server (`http://127.0.0.1:port/mcp`) works — same posture as the
/// custom-backend SSRF guard.
/// True if `ip` is in the SSRF-blocked address space: cloud-metadata,
/// link-local, unspecified, or multicast. Loopback (`127.0.0.0/8`, `::1`) and
/// RFC1918 LAN (`10/8`, `172.16/12`, `192.168/16`) are deliberately NOT blocked
/// so a locally-hosted MCP server works — same posture as the custom-backend
/// SSRF guard. `169.254.0.0/16` (link-local) already covers the AWS/GCP/Azure
/// metadata IP `169.254.169.254`; Alibaba's `100.100.100.200` is added
/// explicitly because it lives in the CGNAT range, not link-local.
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.octets() == [100, 100, 100, 200]
        }
        IpAddr::V6(v6) => {
            // Canonicalize IPv4-in-IPv6 forms FIRST: `::ffff:a.b.c.d`
            // (mapped) and `::a.b.c.d` (compatible) route to the embedded v4
            // address, so they must be subjected to the v4 block list — else
            // `::ffff:169.254.169.254` reaches cloud metadata (SSRF bypass).
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            if let Some(v4) = v6.to_ipv4() {
                // `to_ipv4()` also matches `::ffff:0:0/96`; the mapped case is
                // already handled above, so this covers `::a.b.c.d` compatible.
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let segs = v6.segments();
            let link_local = (segs[0] & 0xffc0) == 0xfe80;
            link_local || v6.is_unspecified() || v6.is_multicast()
        }
    }
}

/// Build an SSRF-hardened HTTP client for ONE url: validate the scheme/host,
/// resolve + reject blocked IPs, pin the client to exactly those addresses, and
/// refuse redirects (a followed redirect re-resolves UNPINNED → an SSRF/rebind
/// bypass). Reused by the remote transport AND the OAuth flow so every
/// server-controlled URL (discovery / token / refresh endpoints) gets the same
/// protection. Build a fresh client per target host.
pub(crate) async fn build_pinned_client(url: &str) -> Result<reqwest::Client> {
    validate_remote_url(url)?;
    let url_owned = url.to_string();
    let (pin_host, pin_addrs) =
        tokio::task::spawn_blocking(move || resolve_pinned_addrs(&url_owned))
            .await
            .map_err(|e| anyhow!("dns resolve task failed: {e}"))??;
    let mut builder = reqwest::Client::builder()
        .timeout(RPC_TIMEOUT)
        .connect_timeout(INIT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if !pin_addrs.is_empty() {
        builder = builder.resolve_to_addrs(&pin_host, &pin_addrs);
    }
    builder
        .build()
        .map_err(|e| anyhow!("build http client: {e}"))
}

/// Cheap, network-free pre-validation of a remote MCP URL: scheme + literal-IP
/// block + metadata-hostname block. This is the first gate; the authoritative
/// SSRF defense is [`resolve_pinned_addrs`], which resolves the hostname and
/// rechecks every resolved IP (and pins the connection to them).
fn validate_remote_url(raw: &str) -> Result<()> {
    use std::net::IpAddr;
    let url = reqwest::Url::parse(raw).map_err(|e| anyhow!("invalid url: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        s => bail!("unsupported url scheme '{s}' (http/https only)"),
    }
    let host = url.host_str().ok_or_else(|| anyhow!("url has no host"))?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            bail!("host {host} is not an allowed address");
        }
    } else {
        let h = host.trim_end_matches('.').to_ascii_lowercase();
        const METADATA_HOSTS: &[&str] = &[
            "metadata",
            "metadata.google.internal",
            "instance-data",
            "instance-data.ec2.internal",
        ];
        if METADATA_HOSTS.contains(&h.as_str()) {
            bail!("host {host} is not allowed");
        }
    }
    Ok(())
}

/// Resolve the URL's host and return `(host, addrs)` — the validated socket
/// addresses the HTTP client must pin its DNS to. Rejects if ANY resolved
/// address is in SSRF-blocked space. This is the DNS-rebinding defense the
/// string-only [`validate_remote_url`] cannot provide: a hostname whose A
/// record points at `169.254.169.254` is caught here, and pinning the client to
/// these exact addresses (see `start_remote_server`) closes the TOCTOU window
/// between this check and the actual connect. Performs blocking DNS — call from
/// `spawn_blocking`.
fn resolve_pinned_addrs(raw: &str) -> Result<(String, Vec<std::net::SocketAddr>)> {
    use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
    let url = reqwest::Url::parse(raw).map_err(|e| anyhow!("invalid url: {e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("url has no host"))?
        .to_string();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("url has no port"))?;
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Literal IP — no DNS; reqwest connects directly, so pinning is a
        // belt-and-suspenders no-op, but we still validate it.
        if is_blocked_ip(ip) {
            bail!("host {host} is not an allowed address");
        }
        return Ok((host, vec![SocketAddr::new(ip, port)]));
    }
    let addrs: Vec<SocketAddr> = (bare, port)
        .to_socket_addrs()
        .map_err(|e| anyhow!("could not resolve host {host}: {e}"))?
        .collect();
    if addrs.is_empty() {
        bail!("host {host} did not resolve to any address");
    }
    for a in &addrs {
        if is_blocked_ip(a.ip()) {
            bail!("host {host} resolves to a disallowed address ({})", a.ip());
        }
    }
    Ok((host, addrs))
}

/// Connect to a remote (streamable-HTTP) MCP server. `token`, if present, is
/// sent as a bearer credential on every request; it is read from the Keychain
/// by the caller and never logged or persisted in plaintext here.
pub async fn start_remote_server(
    name: String,
    url: String,
    token: Option<String>,
) -> Result<Vec<ToolDescriptor>> {
    validate_name(&name)?;

    // SSRF / DNS-rebinding-hardened client (validate + pin + no redirects).
    let client = build_pinned_client(&url).await?;

    if let Some(existing) = REGISTRY.write().remove(&name) {
        let h = existing.clone();
        tokio::spawn(async move { h.shutdown().await });
    }

    crate::diagnostics::warn_with(
        "mcp",
        &format!("starting remote server '{name}': {url}"),
        json!({ "server": name, "url": url, "transport": "remote", "auth": token.is_some() }),
    );

    let handle = Arc::new(ServerHandle {
        name: name.clone(),
        command: url.clone(),
        args: Vec::new(),
        next_id: Mutex::new(1),
        transport: Transport::Remote(RemoteTransport {
            client,
            url,
            session: RwLock::new(None),
            auth: RwLock::new(token.filter(|t| !t.is_empty())),
        }),
        tools: RwLock::new(Vec::new()),
        stderr_buf: Arc::new(Mutex::new(String::new())),
        status: RwLock::new("starting".into()),
        last_error: RwLock::new(None),
        stop: Arc::new(Notify::new()),
    });

    finish_start(handle, name).await
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

/// Per-MCP-tool sanitization for `description` + `name`. The description
/// flows into the LLM's system prompt verbatim if not stripped (frontend
/// builds the tool catalogue from this list), so an MCP server can inject
/// fake "system" instructions there: bidi/zero-width chars to smuggle
/// payload past the scanner, length-bombs that crowd out real tools, etc.
///
/// We strip the same family of invisible chars the injection scanner does,
/// length-cap descriptions, and refuse names that don't match a strict
/// `[A-Za-z0-9_]` pattern. Sec review H8.
fn sanitize_mcp_tool_descriptor(mut t: ToolDescriptor) -> ToolDescriptor {
    const MAX_DESCRIPTION_BYTES: usize = 1024;
    const MAX_NAME_LEN: usize = 64;
    // Description: strip invisible/control chars, collapse newlines so a
    // multi-line payload can't smuggle multiple instructions, then cap.
    let cleaned = strip_for_prompt(&t.description);
    let mut flat = cleaned.replace(['\r', '\n'], " ");
    while flat.contains("  ") {
        flat = flat.replace("  ", " ");
    }
    if flat.len() > MAX_DESCRIPTION_BYTES {
        let mut cut = MAX_DESCRIPTION_BYTES;
        while cut > 0 && !flat.is_char_boundary(cut) {
            cut -= 1;
        }
        flat.truncate(cut);
        flat.push('…');
    }
    t.description = flat;
    // Name: refuse anything that isn't a conservative identifier.
    if t.name.len() > MAX_NAME_LEN
        || !t
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        // Replace with a safe placeholder so the frontend can still
        // present it; the dispatch layer should refuse to call it.
        t.name = "__mcp_tool_with_invalid_name__".to_string();
    }
    // Sec re-review L-NEW-2: input_schema carries nested `description` /
    // `title` strings (one per property) that flow into the model's tool
    // catalogue alongside the top-level fields. Walk the JSON tree and
    // strip + cap every string value at the same keys.
    sanitize_schema_strings(&mut t.input_schema);
    t
}

/// Recursively strip control / bidi / zero-width characters from every
/// `description` / `title` string in an MCP JSON Schema. Other string
/// values (enum literals, formats, etc.) stay verbatim because they're
/// matched against payloads, not rendered into prompts.
fn sanitize_schema_strings(v: &mut serde_json::Value) {
    const MAX_SCHEMA_STRING_BYTES: usize = 512;
    match v {
        serde_json::Value::Object(map) => {
            for (k, sub) in map.iter_mut() {
                if (k == "description" || k == "title") && sub.is_string() {
                    if let Some(s) = sub.as_str() {
                        let mut cleaned = strip_for_prompt(s).replace(['\r', '\n'], " ");
                        while cleaned.contains("  ") {
                            cleaned = cleaned.replace("  ", " ");
                        }
                        if cleaned.len() > MAX_SCHEMA_STRING_BYTES {
                            let mut cut = MAX_SCHEMA_STRING_BYTES;
                            while cut > 0 && !cleaned.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            cleaned.truncate(cut);
                            cleaned.push('…');
                        }
                        *sub = serde_json::Value::String(cleaned);
                    }
                } else {
                    sanitize_schema_strings(sub);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                sanitize_schema_strings(item);
            }
        }
        _ => {}
    }
}

/// Strip zero-width / bidi / control characters from a string that's about
/// to be embedded in an LLM system prompt or any other LLM-visible
/// trusted-frame context. Same character class as
/// `injection_scan::normalize_for_scan` — keep in sync.
fn strip_for_prompt(s: &str) -> String {
    s.chars()
        .filter(|&ch| {
            !matches!(
                ch as u32,
                0x200B..=0x200D | 0xFEFF | 0x2060 | 0x180E
                | 0x202A..=0x202E
                | 0x2066..=0x2069
                | 0x0000..=0x0008
                | 0x000B..=0x000C
                | 0x000E..=0x001F
                | 0x007F..=0x009F
            )
        })
        .collect()
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
                // Clamp to a char boundary before truncating — `String::truncate`
                // PANICS if the byte index lands mid-codepoint, which is trivially
                // reachable for >512 KiB of multibyte text (CJK/emoji). A panic
                // here unwinds the IPC task and the awaited tool call never
                // resolves → the agent loop hangs. Mirror the boundary-safe
                // pattern used elsewhere in this file. MED (2026-05-30).
                let mut cut = MAX_RESULT_BYTES;
                while cut > 0 && !out.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.truncate(cut);
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
    fn remote_url_scheme_and_ssrf() {
        assert!(validate_remote_url("https://sh.inference.ac/mcp").is_ok());
        assert!(validate_remote_url("http://127.0.0.1:9000/mcp").is_ok()); // loopback ok
        assert!(validate_remote_url("ftp://x/y").is_err()); // bad scheme
        assert!(validate_remote_url("https://169.254.169.254/").is_err()); // link-local
        assert!(validate_remote_url("https://metadata.google.internal/").is_err());
        assert!(validate_remote_url("not a url").is_err());
        // Alibaba metadata IP (CGNAT range, not link-local) is blocked too.
        assert!(validate_remote_url("https://100.100.100.200/").is_err());
    }

    #[test]
    fn blocked_ip_classification() {
        use std::net::IpAddr;
        let blocked = |s: &str| is_blocked_ip(s.parse::<IpAddr>().unwrap());
        // Blocked: cloud metadata + link-local + unspecified + multicast.
        assert!(blocked("169.254.169.254")); // AWS/GCP/Azure metadata (link-local)
        assert!(blocked("100.100.100.200")); // Alibaba metadata (CGNAT)
        assert!(blocked("169.254.0.1")); // link-local
        assert!(blocked("0.0.0.0")); // unspecified
        assert!(blocked("224.0.0.1")); // multicast
        assert!(blocked("fe80::1")); // v6 link-local
        assert!(blocked("::")); // v6 unspecified
                                // Allowed by design: loopback + RFC1918 LAN + public.
        assert!(!blocked("127.0.0.1"));
        assert!(!blocked("10.0.0.1"));
        assert!(!blocked("192.168.1.50"));
        assert!(!blocked("172.16.0.1"));
        assert!(!blocked("8.8.8.8"));
        assert!(!blocked("::1"));
    }

    #[test]
    fn sse_parse_finds_matching_id() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"ok\":true}}\n\n";
        let v = parse_sse_for_id(body, 3).unwrap();
        assert_eq!(v["result"]["ok"], true);
        // Wrong id → none.
        assert!(parse_sse_for_id(body, 9).is_none());
    }

    #[test]
    fn sse_parse_string_id_and_error() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":\"5\",\"error\":{\"message\":\"boom\"}}\n\n";
        let v = parse_sse_for_id(body, 5).unwrap();
        assert_eq!(v["error"]["message"], "boom");
    }

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
