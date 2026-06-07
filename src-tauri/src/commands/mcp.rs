//! Model Context Protocol server management commands.

use crate::{
    approval,
    commands::agent::{binding_for, verify_bound, ApprovalPayload},
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
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn mcp_stop_server(name: String) -> Result<(), String> {
    mcp::stop_server(&name).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn mcp_list_servers() -> Vec<mcp::ServerInfo> {
    mcp::list_servers()
}

#[tauri::command]
pub fn mcp_list_tools(name: String) -> Result<Vec<mcp::ToolDescriptor>, String> {
    mcp::list_tools(&name).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    args: Option<serde_json::Value>,
    approval: String,
) -> Result<String, String> {
    // Approval gate (sec audit C2, 2026-05-26): MCP-provided tools are
    // out-of-process and can do anything their server permits — filesystem,
    // shell, network, etc. The agent-loop runner shows a confirmation modal
    // before every MCP tool call, but without a Rust-side gate a compromised
    // renderer could invoke this IPC directly and skip the modal. Token is
    // bound to (server, tool) so a token approved for `fs__read_file` can't
    // be silently replayed against `fs__delete_file` on the same server.
    verify_bound(
        "mcp_call_tool",
        &approval,
        ApprovalPayload {
            mcp_server: Some(server.clone()),
            mcp_tool: Some(tool.clone()),
            ..Default::default()
        },
    )?;
    let args = args.unwrap_or(serde_json::json!({}));
    mcp::call_tool(&server, &tool, args)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn mcp_server_stderr(name: String) -> Option<String> {
    mcp::server_stderr(&name).await
}

/// Connect a remote (streamable-HTTP) MCP server. Approval reuses the
/// `mcp_start_server` binding with the endpoint URL standing in for the
/// command — connecting an MCP server and handing it a token still warrants
/// explicit approval, even though no local process is spawned. The bearer
/// token (if supplied) is stored in the Keychain (account `mcp:<name>`) and
/// never persisted in settings.json; a re-start with `token: None` reads the
/// stored one.
#[tauri::command]
pub async fn mcp_start_remote_server(
    name: String,
    url: String,
    token: Option<String>,
    approval: String,
) -> Result<Vec<mcp::ToolDescriptor>, String> {
    let payload = ApprovalPayload {
        mcp_command: Some(url.clone()),
        mcp_args: Some(Vec::new()),
        mcp_env_keys: Some(Vec::new()),
        ..Default::default()
    };
    let Some(expected) = binding_for("mcp_start_server", &payload) else {
        return Err("internal: mcp_start_remote_server binding missing".into());
    };
    if !approval::consume_with_binding("mcp_start_server", &approval, &expected) {
        return Err("tool approval required or expired".into());
    }

    let kc = format!("mcp:{name}");
    let provided = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if let Some(t) = &provided {
        crate::settings::keychain_set_account(&kc, t);
    }
    let effective = provided.or_else(|| crate::settings::keychain_get(&kc));

    mcp::start_remote_server(name, url, effective)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Whether a Keychain token is stored for a remote MCP server.
#[tauri::command]
pub fn mcp_remote_has_token(name: String) -> bool {
    crate::settings::keychain_get(&format!("mcp:{name}")).is_some()
}

/// Drop a remote MCP server's stored token + any OAuth creds (call on remove).
#[tauri::command]
pub fn mcp_delete_remote_token(name: String) {
    crate::settings::keychain_delete_account(&format!("mcp:{name}"));
    crate::settings::keychain_delete_account(&format!("mcp_oauth:{name}"));
}

/// One-click OAuth connect for a remote MCP server: run the browser auth flow
/// (discover → register → PKCE → token), persist the tokens, then start the
/// server. Same approval gate as `mcp_start_remote_server` (consumed up front,
/// before the browser wait).
#[tauri::command]
pub async fn mcp_oauth_connect(
    app: tauri::AppHandle,
    name: String,
    url: String,
    approval: String,
) -> Result<Vec<mcp::ToolDescriptor>, String> {
    let payload = ApprovalPayload {
        mcp_command: Some(url.clone()),
        mcp_args: Some(Vec::new()),
        mcp_env_keys: Some(Vec::new()),
        ..Default::default()
    };
    let Some(expected) = binding_for("mcp_start_server", &payload) else {
        return Err("internal: mcp_oauth_connect binding missing".into());
    };
    if !approval::consume_with_binding("mcp_start_server", &approval, &expected) {
        return Err("tool approval required or expired".into());
    }

    let creds = mcp::oauth::connect(&app, &url)
        .await
        .map_err(|e| format!("{e:#}"))?;
    crate::settings::keychain_set_account(&format!("mcp:{name}"), &creds.access_token);
    if let Ok(json) = serde_json::to_string(&creds) {
        crate::settings::keychain_set_account(&format!("mcp_oauth:{name}"), &json);
    }
    mcp::start_remote_server(name, url, Some(creds.access_token))
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Refresh a stored OAuth access token for a remote MCP server. Returns true
/// if a refreshed token was stored (false if no OAuth creds exist).
#[tauri::command]
pub async fn mcp_oauth_refresh(name: String) -> Result<bool, String> {
    let key = format!("mcp_oauth:{name}");
    let Some(json) = crate::settings::keychain_get(&key) else {
        return Ok(false);
    };
    let creds: mcp::oauth::OauthCreds =
        serde_json::from_str(&json).map_err(|e| format!("stored oauth creds: {e}"))?;
    let fresh = mcp::oauth::refresh(&creds)
        .await
        .map_err(|e| format!("{e:#}"))?;
    crate::settings::keychain_set_account(&format!("mcp:{name}"), &fresh.access_token);
    if let Ok(j) = serde_json::to_string(&fresh) {
        crate::settings::keychain_set_account(&key, &j);
    }
    Ok(true)
}

/// A normalized MCP registry listing (from the official registry or PulseMCP).
#[derive(serde::Serialize, Clone)]
pub struct McpRegistryEntry {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    /// "remote" (has an http endpoint) | "package" (npm/pypi → stdio) | "unknown".
    pub transport: String,
    pub remote_url: Option<String>,
    pub package_registry: Option<String>,
    pub package_name: Option<String>,
    pub stars: Option<u64>,
    pub homepage: Option<String>,
    pub source: String,
}

fn registry_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Froglips-MCP-Browser")
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// In-memory cache of the full (unfiltered, deduped) listing per source. The
/// Browse UI refetches on every tab switch / search keystroke; without this
/// the proxy hammers the upstreams and PulseMCP's edge starts answering `410`
/// (its rate-limit response). A short TTL keeps the catalogue fresh enough.
/// Cache map: source key → (inserted-at, full listing). Aliased so the static
/// below isn't a clippy `type_complexity` violation.
type RegistryCacheMap =
    std::collections::HashMap<String, (std::time::Instant, Vec<McpRegistryEntry>)>;
static REGISTRY_CACHE: once_cell::sync::Lazy<std::sync::Mutex<RegistryCacheMap>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const REGISTRY_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// Browse MCP server registries. `source` = "official" (the canonical
/// modelcontextprotocol.io registry) or "pulse" (PulseMCP). `query` filters
/// over name/description. Proxied through Rust (no CORS / keeps the call
/// uniform) and cached per source so rapid UI refetches don't hit the network.
#[tauri::command]
pub async fn mcp_registry_search(
    source: Option<String>,
    query: Option<String>,
) -> Result<Vec<McpRegistryEntry>, String> {
    let source = source.as_deref().unwrap_or("official").to_string();
    if !matches!(source.as_str(), "official" | "pulse") {
        return Err(format!("unknown registry source: {source}"));
    }
    let q = query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    // Serve the full list from cache when fresh (lock released before await).
    let cached = {
        let guard = REGISTRY_CACHE.lock().unwrap();
        guard
            .get(&source)
            .filter(|(t, _)| t.elapsed() < REGISTRY_CACHE_TTL)
            .map(|(_, v)| v.clone())
    };

    let full = if let Some(v) = cached {
        v
    } else {
        let mut v = if source == "pulse" {
            fetch_pulse().await?
        } else {
            fetch_official(&registry_client()?).await?
        };
        // The official registry lists one row per published version — collapse
        // to the first occurrence of each server id.
        let mut seen = std::collections::HashSet::new();
        v.retain(|e| seen.insert(e.id.clone()));
        REGISTRY_CACHE
            .lock()
            .unwrap()
            .insert(source.clone(), (std::time::Instant::now(), v.clone()));
        v
    };

    let out = match &q {
        Some(q) => full
            .into_iter()
            .filter(|e| {
                format!("{} {} {}", e.name, e.title, e.description)
                    .to_lowercase()
                    .contains(q)
            })
            .collect(),
        None => full,
    };
    Ok(out)
}

async fn fetch_official(client: &reqwest::Client) -> Result<Vec<McpRegistryEntry>, String> {
    // Smaller page than PulseMCP's: the official registry's `/v0/servers` route
    // has been observed to hang on large `limit` values (server-side). 30 keeps
    // the response light; the frontend falls back to PulseMCP if this still
    // fails.
    let v: serde_json::Value = client
        .get("https://registry.modelcontextprotocol.io/v0/servers?limit=30")
        .send()
        .await
        .map_err(|e| format!("registry request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("registry bad JSON: {e}"))?;

    let mut out = Vec::new();
    for item in v["servers"].as_array().cloned().unwrap_or_default() {
        // Newer payloads nest under `server`; older are flat.
        let s = if item.get("server").is_some() {
            item["server"].clone()
        } else {
            item.clone()
        };
        let name = s["name"].as_str().unwrap_or_default().to_string();
        if name.is_empty() {
            continue;
        }
        let remote_url = s["remotes"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r["url"].as_str())
            .map(str::to_string);
        let pkg = s["packages"].as_array().and_then(|a| a.first()).cloned();
        let package_registry = pkg.as_ref().and_then(|p| {
            p["registry_type"]
                .as_str()
                .or_else(|| p["registry_name"].as_str())
                .map(str::to_string)
        });
        let package_name = pkg.as_ref().and_then(|p| {
            p["identifier"]
                .as_str()
                .or_else(|| p["name"].as_str())
                .map(str::to_string)
        });
        let transport = if remote_url.is_some() {
            "remote"
        } else if package_name.is_some() {
            "package"
        } else {
            "unknown"
        };
        out.push(McpRegistryEntry {
            id: name.clone(),
            title: s["title"].as_str().unwrap_or(&name).to_string(),
            name,
            description: s["description"].as_str().unwrap_or_default().to_string(),
            transport: transport.to_string(),
            remote_url,
            package_registry,
            package_name,
            stars: None,
            homepage: s["repository"]["url"].as_str().map(str::to_string),
            source: "official".to_string(),
        });
    }
    Ok(out)
}

async fn fetch_pulse() -> Result<Vec<McpRegistryEntry>, String> {
    // PulseMCP's edge throttles with HTTP 410 ("Gone") and is picky about the
    // request shape: a plain/automation-looking request (no Accept-Encoding,
    // or the `gzip, br, deflate` combo reqwest sends by default) gets 410,
    // while a browser-like request (real UA + `Accept-Encoding: gzip`) gets
    // 200. Keep gzip enabled so reqwest decompresses the body; disable
    // brotli/deflate so we advertise only `gzip`.
    const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
        AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(BROWSER_UA)
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // The 410 throttle is intermittent — retry a couple of times with backoff.
    let url = "https://api.pulsemcp.com/v0beta/servers?count_per_page=100";
    let mut last = String::from("PulseMCP request failed");
    let mut resp_ok = None;
    for attempt in 0..3 {
        match client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                resp_ok = Some(r);
                break;
            }
            Ok(r) => last = format!("PulseMCP returned HTTP {}", r.status()),
            Err(e) => last = format!("PulseMCP request failed: {e}"),
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
    }
    let resp = resp_ok.ok_or(last)?;
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("PulseMCP bad JSON: {e}"))?;

    let mut out = Vec::new();
    for s in v["servers"].as_array().cloned().unwrap_or_default() {
        let name = s["name"].as_str().unwrap_or_default().to_string();
        if name.is_empty() {
            continue;
        }
        let package_name = s["package_name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let package_registry = s["package_registry"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let remote_url = s["remote_url"].as_str().map(str::to_string);
        let transport = if remote_url.is_some() {
            "remote"
        } else if package_name.is_some() {
            "package"
        } else {
            "unknown"
        };
        out.push(McpRegistryEntry {
            id: name.clone(),
            title: name.clone(),
            name,
            description: s["short_description"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            transport: transport.to_string(),
            remote_url,
            package_registry,
            package_name,
            stars: s["github_stars"].as_u64(),
            homepage: s["external_url"]
                .as_str()
                .or_else(|| s["source_code_url"].as_str())
                .or_else(|| s["url"].as_str()) // PulseMCP listing page (always present)
                .map(str::to_string),
            source: "pulse".to_string(),
        });
    }
    Ok(out)
}
