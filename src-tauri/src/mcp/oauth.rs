//! One-click OAuth for remote MCP servers — the MCP authorization flow.
//!
//! Many remote MCP servers are OAuth 2.1 resource servers: an unauthenticated
//! request gets `401` and the user must otherwise paste an API key. This module
//! does the browser handshake instead, so "Connect" is one click:
//!
//!   1. **Discover** the authorization server from the MCP URL's origin
//!      (`/.well-known/oauth-protected-resource` → `authorization_servers[0]`,
//!      then that server's `/.well-known/oauth-authorization-server`, falling
//!      back to `/.well-known/openid-configuration`).
//!   2. **Dynamically register** a public client (RFC 7591) with a loopback
//!      redirect URI — no pre-shared `client_id`.
//!   3. **Authorization Code + PKCE** (S256) through the system browser; a tiny
//!      loopback listener catches the redirect.
//!   4. **Exchange** the code for an access (+ refresh) token; `refresh()`
//!      renews it later.
//!
//! Tokens never touch the webview — the caller persists them in the local
//! secret store and the remote transport sends them as `Authorization: Bearer`.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt as _;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// OAuth endpoints carry credentials (the authorization code, the PKCE
/// `code_verifier`, and the refresh token), so they MUST use TLS. Plaintext
/// `http` is permitted ONLY for loopback (a local dev authorization server);
/// any other host over `http` is rejected. Non-`http(s)` schemes (e.g.
/// `file://`, `smb://`, custom URL-handlers) are rejected outright — important
/// because `authorization_endpoint` is handed to the system opener. All three
/// endpoints come from server-controlled discovery JSON, so this is the gate
/// that stops a malicious AS from exfiltrating the PKCE secret in cleartext or
/// abusing a native URL-handler.
fn secure_endpoint(raw: &str) -> Result<()> {
    let url = url::Url::parse(raw).context("parse oauth endpoint")?;
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = url.host_str().unwrap_or("");
            let loopback = host == "localhost"
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false);
            if loopback {
                Ok(())
            } else {
                bail!("oauth endpoint must use https (got plaintext http): {raw}")
            }
        }
        s => bail!("oauth endpoint has unsupported scheme '{s}': {raw}"),
    }
}

/// Credentials persisted after a successful flow. Stored as JSON under the
/// secret-store account `mcp_oauth:<name>`; the bare `access_token` is also
/// written to `mcp:<name>` so the existing remote-start path uses it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthCreds {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_endpoint: String,
    pub client_id: String,
    /// Set only if the AS issued a confidential client (ignored our `none`
    /// auth-method request); sent on token exchange + refresh when present.
    pub client_secret: Option<String>,
    /// The MCP server URL — used as the RFC 8707 `resource` indicator.
    pub resource: String,
}

#[derive(Deserialize)]
struct ProtectedResourceMeta {
    authorization_servers: Option<Vec<String>>,
    scopes_supported: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct AuthServerMeta {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: Option<String>,
}

/// Fill `buf` with CSPRNG bytes, base64url (no pad) encoded.
fn random_b64(len: usize) -> Result<String> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).map_err(|e| anyhow!("getrandom: {e}"))?;
    Ok(B64.encode(&buf))
}

/// PKCE `(verifier, challenge)` with the S256 method.
fn pkce() -> Result<(String, String)> {
    let verifier = random_b64(32);
    let verifier = verifier?;
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// `scheme://host[:port]` for a URL.
fn origin_of(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw).context("parse server url")?;
    let host = u.host_str().context("server url has no host")?;
    Ok(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

/// Discover the authorization-server endpoints for an MCP server URL. Every
/// fetch goes through the SSRF-pinned client; a discovered (server-controlled)
/// URL pointing at blocked space is rejected before any request is made.
async fn discover(server_url: &str) -> Result<(AuthServerMeta, Option<String>)> {
    let origin = origin_of(server_url)?;

    // 1. Protected-resource metadata → authorization server base + the scopes
    //    the resource advertises (best-effort; fall back to the server origin).
    let prm_url = format!("{origin}/.well-known/oauth-protected-resource");
    let prm: Option<ProtectedResourceMeta> = match super::build_pinned_client(&prm_url).await {
        Ok(c) => match c.get(&prm_url).send().await {
            Ok(r) if r.status().is_success() => super::read_json_capped(r, super::MAX_RESULT_BYTES)
                .await
                .ok(),
            _ => None,
        },
        Err(_) => None,
    };
    // Request the scopes the resource declares — some authorization servers
    // reject a request with no scope or issue an unusable token without it.
    let scope = prm
        .as_ref()
        .and_then(|m| m.scopes_supported.as_ref())
        .map(|v| v.join(" "))
        .filter(|s| !s.is_empty());
    let as_base = prm
        .and_then(|m| m.authorization_servers)
        .and_then(|v| v.into_iter().next())
        .unwrap_or_else(|| origin.clone());
    let as_base = as_base.trim_end_matches('/');

    // 2. Authorization-server metadata (OAuth, then OIDC fallback).
    for path in [
        ".well-known/oauth-authorization-server",
        ".well-known/openid-configuration",
    ] {
        let meta_url = format!("{as_base}/{path}");
        // Gate discovery URLs through the same https-or-loopback check as the
        // endpoints below — a malicious authorization-server pointer must not
        // make us fetch metadata over cleartext http to a public host.
        if secure_endpoint(&meta_url).is_err() {
            continue;
        }
        if let Ok(c) = super::build_pinned_client(&meta_url).await {
            if let Ok(r) = c.get(&meta_url).send().await {
                if r.status().is_success() {
                    if let Ok(m) =
                        super::read_json_capped::<AuthServerMeta>(r, super::MAX_RESULT_BYTES).await
                    {
                        return Ok((m, scope));
                    }
                }
            }
        }
    }
    bail!("could not discover OAuth endpoints for {server_url} (no authorization-server metadata, or it resolves to blocked space)")
}

/// Dynamic Client Registration (RFC 7591) → `(client_id, client_secret?)`.
async fn register(
    reg_ep: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<(String, Option<String>)> {
    let client = super::build_pinned_client(reg_ep).await?;
    #[derive(Serialize)]
    struct Req<'a> {
        client_name: &'a str,
        redirect_uris: Vec<&'a str>,
        grant_types: Vec<&'a str>,
        response_types: Vec<&'a str>,
        token_endpoint_auth_method: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<&'a str>,
    }
    #[derive(Deserialize)]
    struct Resp {
        client_id: String,
        client_secret: Option<String>,
    }
    let body = Req {
        client_name: "Froglips",
        redirect_uris: vec![redirect_uri],
        grant_types: vec!["authorization_code", "refresh_token"],
        response_types: vec!["code"],
        token_endpoint_auth_method: "none",
        scope,
    };
    let r = client
        .post(reg_ep)
        .json(&body)
        .send()
        .await
        .context("dynamic client registration request")?;
    if !r.status().is_success() {
        bail!(
            "dynamic client registration failed: {} {}",
            r.status(),
            r.text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    let resp: Resp = super::read_json_capped(r, super::MAX_RESULT_BYTES)
        .await
        .context("DCR response")?;
    Ok((resp.client_id, resp.client_secret))
}

/// Run the full flow: discover → register → browser auth (PKCE) → token.
/// Opens the system browser and blocks on the loopback callback (5-min cap).
pub async fn connect(app: &tauri::AppHandle, server_url: &str) -> Result<OauthCreds> {
    let (meta, scope) = discover(server_url).await?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind loopback callback")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let reg_ep = meta
        .registration_endpoint
        .as_deref()
        .context("server does not support dynamic client registration; paste an API key instead")?;
    secure_endpoint(reg_ep)?;
    secure_endpoint(&meta.authorization_endpoint)?;
    secure_endpoint(&meta.token_endpoint)?;
    let (client_id, client_secret) = register(reg_ep, &redirect_uri, scope.as_deref()).await?;

    let (verifier, challenge) = pkce()?;
    let state = random_b64(16)?;

    let mut auth_url =
        url::Url::parse(&meta.authorization_endpoint).context("parse auth endpoint")?;
    {
        let mut q = auth_url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", server_url);
        if let Some(s) = &scope {
            q.append_pair("scope", s);
        }
    }

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| anyhow!("open browser for authorization: {e}"))?;

    let (code, got_state) = tokio::time::timeout(CALLBACK_TIMEOUT, accept_callback(listener))
        .await
        .map_err(|_| anyhow!("OAuth timed out after {}s", CALLBACK_TIMEOUT.as_secs()))??;
    if got_state != state {
        bail!("OAuth state mismatch — possible CSRF, aborting");
    }

    let mut params: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", server_url),
    ];
    if let Some(secret) = &client_secret {
        params.push(("client_secret", secret));
    }
    let r = super::build_pinned_client(&meta.token_endpoint)
        .await?
        .post(&meta.token_endpoint)
        .form(&params)
        .send()
        .await
        .context("token exchange request")?;
    if !r.status().is_success() {
        bail!(
            "token exchange failed: {} {}",
            r.status(),
            r.text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        );
    }
    let tok: TokenResp = super::read_json_capped(r, super::MAX_RESULT_BYTES)
        .await
        .context("token response")?;
    Ok(OauthCreds {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        token_endpoint: meta.token_endpoint,
        client_id,
        client_secret,
        resource: server_url.to_string(),
    })
}

/// Renew an access token with the stored refresh token.
pub async fn refresh(creds: &OauthCreds) -> Result<OauthCreds> {
    let rt = creds
        .refresh_token
        .as_deref()
        .context("no refresh token stored")?;
    let mut params: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", rt),
        ("client_id", creds.client_id.as_str()),
        ("resource", creds.resource.as_str()),
    ];
    if let Some(secret) = &creds.client_secret {
        params.push(("client_secret", secret));
    }
    secure_endpoint(&creds.token_endpoint)?;
    let r = super::build_pinned_client(&creds.token_endpoint)
        .await?
        .post(&creds.token_endpoint)
        .form(&params)
        .send()
        .await
        .context("token refresh request")?;
    if !r.status().is_success() {
        bail!("token refresh failed: {}", r.status());
    }
    let tok: TokenResp = super::read_json_capped(r, super::MAX_RESULT_BYTES)
        .await
        .context("refresh response")?;
    Ok(OauthCreds {
        access_token: tok.access_token,
        // Servers may omit a new refresh token → keep the old one.
        refresh_token: tok.refresh_token.or_else(|| creds.refresh_token.clone()),
        ..creds.clone()
    })
}

/// Accept loopback requests until one carries `code`/`error`, reply with a
/// close-the-tab page, and return `(code, state)`. Non-OAuth hits (favicon
/// etc.) get a 404 and are ignored.
async fn accept_callback(listener: tokio::net::TcpListener) -> Result<(String, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    loop {
        let (mut sock, _) = listener.accept().await.context("accept callback")?;
        // Read until we have a complete request line (the GET line can split
        // across TCP segments — a long `code` query makes this real). Cap at
        // 64 KiB so a misbehaving client can't grow the buffer unbounded.
        let mut raw: Vec<u8> = Vec::with_capacity(8192);
        let mut chunk = [0u8; 8192];
        loop {
            if raw.windows(2).any(|w| w == b"\r\n") || raw.contains(&b'\n') {
                break;
            }
            match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(k) => {
                    raw.extend_from_slice(&chunk[..k]);
                    if raw.len() >= 64 * 1024 {
                        break;
                    }
                }
            }
        }
        let req = String::from_utf8_lossy(&raw);
        let path = req
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        let parsed = url::Url::parse(&format!("http://localhost{path}")).ok();
        let (mut code, mut state, mut err) = (None, None, None);
        if let Some(p) = &parsed {
            for (k, v) in p.query_pairs() {
                match k.as_ref() {
                    "code" => code = Some(v.into_owned()),
                    "state" => state = Some(v.into_owned()),
                    "error" => err = Some(v.into_owned()),
                    _ => {}
                }
            }
        }
        if code.is_none() && err.is_none() {
            // Not the OAuth redirect (e.g. /favicon.ico) — 404 and keep waiting.
            let _ = sock
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            let _ = sock.shutdown().await;
            continue;
        }
        let html = "<!doctype html><html><body style=\"font-family:system-ui;padding:2rem;background:#0b0b0f;color:#e5e5e5\"><h2>\u{2713} Connected</h2><p>You can close this tab and return to Froglips.</p></body></html>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(e) = err {
            bail!("authorization denied: {e}");
        }
        return Ok((
            code.context("callback missing code")?,
            state.unwrap_or_default(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (v, c) = pkce().unwrap();
        // verifier is 32 random bytes → 43 base64url chars; challenge is the
        // base64url of SHA-256(verifier).
        assert_eq!(v.len(), 43);
        let expect = B64.encode(Sha256::digest(v.as_bytes()));
        assert_eq!(c, expect);
        assert!(!c.contains('=') && !c.contains('+') && !c.contains('/'));
    }

    #[test]
    fn random_b64_is_unique_and_urlsafe() {
        let a = random_b64(16).unwrap();
        let b = random_b64(16).unwrap();
        assert_ne!(a, b);
        assert!(!a.contains('=') && !a.contains('+') && !a.contains('/'));
    }

    #[test]
    fn origin_strips_path_keeps_port() {
        assert_eq!(
            origin_of("https://api.example.ai/mcp").unwrap(),
            "https://api.example.ai"
        );
        assert_eq!(
            origin_of("http://127.0.0.1:9000/mcp").unwrap(),
            "http://127.0.0.1:9000"
        );
    }

    #[test]
    fn discovery_meta_parses() {
        let m: AuthServerMeta = serde_json::from_str(
            r#"{"authorization_endpoint":"https://a/authorize","token_endpoint":"https://a/token","registration_endpoint":"https://a/register"}"#,
        )
        .unwrap();
        assert_eq!(m.authorization_endpoint, "https://a/authorize");
        assert_eq!(
            m.registration_endpoint.as_deref(),
            Some("https://a/register")
        );
    }
}
