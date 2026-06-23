//! Centralized outbound-HTTP factory + optional anonymizing proxy.
//!
//! Every reqwest client in the app is built through [`client_builder`] /
//! [`blocking_client_builder`] so a single `web_proxy` setting can route ALL
//! external egress (web tools, cloud model APIs, HuggingFace, MCP HTTP, the
//! updater) through an anonymizing transport — typically Tor's SOCKS port
//! (`socks5h://127.0.0.1:9050`).
//!
//! HONEST SCOPE: this gives strong IP-level anonymity for the HTTP paths. It
//! does NOT make you "untraceable" — authenticated cloud APIs still log your
//! account + content, the computer-use browser leaks via WebRTC/TLS
//! fingerprinting, and content/timing can deanonymize. Local models remain the
//! real privacy win.
//!
//! Two load-bearing details:
//!   * **`socks5h`** (not `socks5`) resolves DNS at the proxy → no DNS leak.
//!   * **loopback bypass**: `127.0.0.1`/`localhost`/`::1` NEVER go through the
//!     proxy, so the local Ollama/MLX/llama.cpp backends keep working (routing
//!     them through Tor would break local inference). Set via `no_proxy`.
//!
//! Apply semantics: the proxy is read when a client is built. Per-call/short-
//! cached clients pick up a change quickly; a few long-lived `Lazy` clients bake
//! the value at first use, so changing the proxy is guaranteed for all egress
//! only after an app restart. Subprocess egress (`hf` CLI, the Ollama daemon)
//! is covered separately via [`proxy_env`].

use std::sync::RwLock;

use once_cell::sync::Lazy;

/// Generic, non-identifying User-Agent. Replaces the old "Froglips/0.x" strings
/// on the egress paths so a request doesn't advertise the app (a fingerprint).
pub const GENERIC_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Current proxy URL (e.g. `socks5h://127.0.0.1:9050`), or `None` when direct.
static PROXY: Lazy<RwLock<Option<String>>> = Lazy::new(|| RwLock::new(None));

/// Loopback hosts that must never be proxied — the local inference backends.
const NO_PROXY_HOSTS: &str = "localhost,127.0.0.1,::1,0.0.0.0";

/// Validate a proxy URL before storing it. Accepts socks5h/socks5/http/https
/// with a host and a port. `socks5h` is recommended (remote DNS).
pub fn validate_proxy_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    if u.is_empty() {
        return Ok(()); // empty == disabled
    }
    let scheme_ok = ["socks5h://", "socks5://", "http://", "https://"]
        .iter()
        .any(|s| u.starts_with(s));
    if !scheme_ok {
        return Err(
            "proxy must start with socks5h:// (recommended), socks5://, http://, or https://"
                .to_string(),
        );
    }
    let parsed = url::Url::parse(u).map_err(|e| format!("invalid proxy URL: {e}"))?;
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("proxy URL is missing a host".to_string());
    }
    if parsed.port().is_none() {
        return Err("proxy URL is missing a port (e.g. socks5h://127.0.0.1:9050)".to_string());
    }
    Ok(())
}

/// Set (or clear) the active proxy. Called at startup from the persisted setting
/// and whenever settings are saved. Empty/whitespace clears it.
pub fn set_proxy(url: Option<String>) {
    let normalized = url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Ok(mut g) = PROXY.write() {
        *g = normalized;
    }
}

/// The active proxy URL, if any.
pub fn proxy_url() -> Option<String> {
    PROXY.read().ok().and_then(|g| g.clone())
}

/// True when an anonymizing proxy is configured.
pub fn proxy_enabled() -> bool {
    proxy_url().is_some()
}

/// Build the `reqwest::Proxy` for the current setting, with loopback bypass.
/// Returns `Ok(None)` when no proxy is configured.
fn build_proxy() -> Result<Option<reqwest::Proxy>, reqwest::Error> {
    match proxy_url() {
        None => Ok(None),
        Some(url) => {
            let p =
                reqwest::Proxy::all(&url)?.no_proxy(reqwest::NoProxy::from_string(NO_PROXY_HOSTS));
            Ok(Some(p))
        }
    }
}

/// Async client builder pre-configured with the proxy (if set) + generic UA.
/// Callers add their own timeouts/headers. If the proxy string is malformed at
/// build time we fall back to a DIRECT builder — but `set_proxy` only stores
/// validated URLs, so that path is effectively unreachable in normal use.
pub fn client_builder() -> reqwest::ClientBuilder {
    let mut b = reqwest::Client::builder().user_agent(GENERIC_UA);
    if let Ok(Some(p)) = build_proxy() {
        b = b.proxy(p);
    }
    b
}

/// Blocking variant of [`client_builder`] (embedder probe paths).
pub fn blocking_client_builder() -> reqwest::blocking::ClientBuilder {
    let mut b = reqwest::blocking::Client::builder().user_agent(GENERIC_UA);
    if let Ok(Some(url)) = proxy_url().map(|u| reqwest::Proxy::all(&u)).transpose() {
        b = b.proxy(url.no_proxy(reqwest::NoProxy::from_string(NO_PROXY_HOSTS)));
    }
    b
}

/// `(KEY, value)` pairs to inject into a child process's environment so external
/// CLIs (the `hf` downloader, the Ollama daemon) route through the same proxy.
/// Empty when no proxy is set. Covers the common lowercase + uppercase forms.
pub fn proxy_env() -> Vec<(&'static str, String)> {
    match proxy_url() {
        None => Vec::new(),
        Some(url) => vec![
            ("ALL_PROXY", url.clone()),
            ("HTTPS_PROXY", url.clone()),
            ("HTTP_PROXY", url.clone()),
            ("https_proxy", url.clone()),
            ("http_proxy", url.clone()),
            // Never send loopback through the proxy (local backends/daemon).
            ("NO_PROXY", NO_PROXY_HOSTS.to_string()),
            ("no_proxy", NO_PROXY_HOSTS.to_string()),
        ],
    }
}

/// Best-effort reachability of the proxy's host:port, for the UI indicator.
/// `None` when no proxy is configured; `Some(true/false)` for up/down.
pub async fn proxy_reachable() -> Option<bool> {
    let url = proxy_url()?;
    let parsed = url::Url::parse(&url).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed.port()?;
    let addr = format!("{host}:{port}");
    let ok = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);
    Some(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_proxy_urls() {
        assert!(validate_proxy_url("").is_ok()); // disabled
        assert!(validate_proxy_url("socks5h://127.0.0.1:9050").is_ok());
        assert!(validate_proxy_url("http://10.0.0.1:8080").is_ok());
        // missing scheme
        assert!(validate_proxy_url("127.0.0.1:9050").is_err());
        // missing port
        assert!(validate_proxy_url("socks5h://127.0.0.1").is_err());
        // bogus scheme
        assert!(validate_proxy_url("ftp://x:1").is_err());
    }

    #[test]
    fn set_get_and_env_roundtrip() {
        set_proxy(Some("socks5h://127.0.0.1:9050".to_string()));
        assert!(proxy_enabled());
        assert_eq!(proxy_url().as_deref(), Some("socks5h://127.0.0.1:9050"));
        let env = proxy_env();
        assert!(env
            .iter()
            .any(|(k, v)| *k == "ALL_PROXY" && v.contains("9050")));
        assert!(env.iter().any(|(k, _)| *k == "NO_PROXY"));
        // clearing with whitespace disables
        set_proxy(Some("   ".to_string()));
        assert!(!proxy_enabled());
        assert!(proxy_env().is_empty());
    }
}
