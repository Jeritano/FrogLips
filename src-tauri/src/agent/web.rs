use serde::{Deserialize, Serialize};

use super::fs::{err_string, ToolError};
use super::injection_scan;

#[derive(Serialize)]
pub struct WebFetchResult {
    pub url: String,
    pub status: u16,
    pub content: String,
    pub bytes: u64,
    pub truncated: bool,
}

const WEB_FETCH_MAX_BYTES: usize = 1_048_576; // 1 MiB
const WEB_FETCH_TIMEOUT_SECS: u64 = 15;

pub fn is_safe_public_host(host: &str) -> bool {
    // Reject localhost + RFC1918 + link-local + .local — defends against SSRF.
    let h = host.to_ascii_lowercase();
    if h.is_empty() || h == "localhost" || h.ends_with(".local") || h.ends_with(".internal") {
        return false;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(a) => {
                let oct = a.octets();
                if a.is_loopback()
                    || a.is_private()
                    || a.is_link_local()
                    || a.is_unspecified()
                    || a.is_multicast()
                    || a.is_broadcast()
                {
                    return false;
                }
                // 169.254.169.254 + AWS/GCP metadata, etc. — caught by link_local
                if oct[0] == 0 || oct[0] == 127 {
                    return false;
                }
            }
            std::net::IpAddr::V6(a) => {
                if a.is_loopback() || a.is_unspecified() || a.is_multicast() {
                    return false;
                }
                let segs = a.segments();
                if segs[0] == 0xfe80 || segs[0] == 0xfc00 || segs[0] == 0xfd00 {
                    return false;
                }
            }
        }
    }
    true
}

/// Pre-flight: resolve hostname to socket addresses and reject if any one of
/// them lands in a private / loopback / link-local range. Closes the gap
/// where `is_safe_public_host()` only catches IP-literal hosts and explicit
/// `.local` / `.internal` names — services like `localtest.me` and
/// `1.lvh.me` resolve to 127.0.0.1 while passing the string check.
///
/// We do this regardless of whether `host` parsed as an IP literal (which
/// our string-level check already covered) so the same call covers both
/// hostname and IP-literal cases.
fn is_safe_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => {
            let oct = a.octets();
            !(a.is_loopback()
                || a.is_private()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_multicast()
                || a.is_broadcast()
                || oct[0] == 0
                || oct[0] == 127)
        }
        std::net::IpAddr::V6(a) => {
            let segs = a.segments();
            !(a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || segs[0] == 0xfe80
                || segs[0] == 0xfc00
                || segs[0] == 0xfd00)
        }
    }
}

/// Resolve hostname to SocketAddrs and keep only the ones in safe ranges.
/// Returns the safe set so callers can pin reqwest's resolver to exactly
/// those addresses — closes the TOCTOU window where reqwest would re-query
/// DNS at connect time and possibly land on a poisoned IP.
pub async fn resolve_to_safe_addrs(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{host}:{port}"))
        .await
        .map_err(|e| {
            err_string(ToolError::invalid(format!(
                "hostname does not resolve: {e}"
            )))
        })?
        .collect();
    if addrs.is_empty() {
        return Err(err_string(ToolError::invalid(format!(
            "host '{host}' yielded no addresses"
        ))));
    }
    for a in &addrs {
        if !is_safe_ip(&a.ip()) {
            return Err(err_string(ToolError::Protected {
                message: format!(
                    "host '{host}' resolves to a private/loopback address ({}) — blocked",
                    a.ip()
                ),
            }));
        }
    }
    Ok(addrs)
}

/// Custom redirect policy: re-validate each hop against is_safe_public_host
/// and scheme, then re-resolve DNS so a redirect to a host that resolves to a
/// loopback address (e.g. localtest.me) is rejected the same way the initial
/// request is. Default `Policy::limited(5)` would happily follow a 302 to a
/// loopback URL.
fn ssrf_safe_redirect() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        if url.scheme() != "https" && url.scheme() != "http" {
            return attempt.error("redirect to non-http(s) scheme");
        }
        let host = url.host_str().unwrap_or("");
        if !is_safe_public_host(host) {
            return attempt.error("redirect to private/loopback host");
        }
        // The redirect-policy closure is sync, so resolve DNS synchronously
        // here. lookup blocks briefly but only on a redirect hop.
        let port = url.port_or_known_default().unwrap_or(443);
        match std::net::ToSocketAddrs::to_socket_addrs(&(host, port)) {
            Ok(addrs) => {
                let mut any = false;
                for a in addrs {
                    any = true;
                    if !is_safe_ip(&a.ip()) {
                        return attempt
                            .error("redirect host resolves to a private/loopback address");
                    }
                }
                if !any {
                    return attempt.error("redirect host did not resolve");
                }
            }
            Err(_) => return attempt.error("redirect host did not resolve"),
        }
        attempt.follow()
    })
}

/// Stream the response body, accumulating up to `cap` bytes. Bails as soon as
/// the cap is hit — defends against a server replying with a huge body that
/// would otherwise OOM us via reqwest's all-at-once `.bytes()`.
async fn read_capped(resp: reqwest::Response, cap: usize) -> Result<(Vec<u8>, u64, bool), String> {
    use futures::StreamExt;
    let content_len_hint = resp.content_length().unwrap_or(0);
    let mut out = Vec::with_capacity(content_len_hint.min(cap as u64) as usize);
    let mut stream = resp.bytes_stream();
    let mut total: u64 = 0;
    let mut truncated = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| err_string(ToolError::io(e.to_string())))?;
        total += chunk.len() as u64;
        if out.len() + chunk.len() > cap {
            let remaining = cap.saturating_sub(out.len());
            out.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        out.extend_from_slice(&chunk);
    }
    Ok((out, total, truncated))
}

pub async fn web_fetch(url_str: String) -> Result<WebFetchResult, String> {
    let url = url::Url::parse(&url_str)
        .map_err(|e| err_string(ToolError::invalid(format!("bad url: {e}"))))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(err_string(ToolError::invalid("only http(s) urls allowed")));
    }
    let host = url.host_str().unwrap_or("").to_string();
    if !is_safe_public_host(&host) {
        return Err(err_string(ToolError::Protected {
            message: format!(
                "host '{host}' is private/loopback/link-local — blocked to prevent SSRF"
            ),
        }));
    }
    let default_port = url.port_or_known_default().unwrap_or(443);
    let safe_addrs = resolve_to_safe_addrs(&host, default_port).await?;

    // Pin reqwest's DNS resolution to the addresses we pre-validated. This
    // closes the TOCTOU window where the caller's DNS could return a
    // different IP at connect time. The set covers the initial host only;
    // redirect targets re-validate via ssrf_safe_redirect.
    let mut client_builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
        .user_agent("Froglips/0.9 (+https://github.com/Jeritano/FrogLips)")
        .redirect(ssrf_safe_redirect());
    for a in &safe_addrs {
        client_builder = client_builder.resolve_to_addrs(&host, &[*a]);
    }
    let client = client_builder
        .build()
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;

    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    let status = resp.status().as_u16();

    let (bytes, total, truncated) = read_capped(resp, WEB_FETCH_MAX_BYTES).await?;
    let cap = bytes.len();
    let body_text = String::from_utf8_lossy(&bytes[..cap]).into_owned();

    // Strip HTML if it looks like HTML — agent gets clean text.
    let looks_html = body_text.contains("<html")
        || body_text.contains("<HTML")
        || body_text.contains("<body")
        || body_text.contains("<!DOCTYPE");
    let content = if looks_html {
        html2text::from_read(body_text.as_bytes(), 100).unwrap_or(body_text)
    } else {
        body_text
    };

    // Treat the fetched page as untrusted external content: scan for
    // prompt-injection patterns and wrap with a DATA-only warning if any
    // are found. The agent still gets the substantive text.
    let (content, _n_findings) = injection_scan::scan_and_wrap(&content);

    Ok(WebFetchResult {
        url: url_str,
        status,
        content,
        bytes: total,
        truncated,
    })
}

#[derive(Serialize)]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct WebSearchResult {
    pub query: String,
    pub hits: Vec<WebSearchHit>,
}

pub async fn web_search(query: String, n: Option<usize>) -> Result<WebSearchResult, String> {
    if query.trim().is_empty() {
        return Err(err_string(ToolError::invalid("query must not be empty")));
    }
    if query.len() > 512 {
        return Err(err_string(ToolError::invalid("query too long")));
    }
    let n = n.unwrap_or(5).min(20);

    // DuckDuckGo HTML endpoint — no API key needed. Brittle but adequate.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Froglips")
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;

    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding(&query)
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    let text = resp
        .text()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;

    // Parse <a class="result__a" href="..."> + <a class="result__snippet">
    static RESULT_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(
            r#"(?s)<a\s+rel="nofollow"\s+class="result__a"\s+href="([^"]+)"[^>]*>(.*?)</a>.*?<a\s+class="result__snippet"[^>]*>(.*?)</a>"#
        ).unwrap()
    });
    fn strip_tags(s: &str) -> String {
        let no_tags = regex::Regex::new(r"<[^>]*>").unwrap().replace_all(s, "");
        no_tags
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#x27;", "'")
            .replace("&#39;", "'")
            .trim()
            .to_string()
    }
    fn unwrap_ddg_redirect(href: &str) -> String {
        // DDG returns //duckduckgo.com/l/?uddg=<url>&...
        if let Some(idx) = href.find("uddg=") {
            let enc = &href[idx + 5..];
            let end = enc.find('&').unwrap_or(enc.len());
            return percent_decode(&enc[..end]);
        }
        href.to_string()
    }

    let mut hits = Vec::new();
    for cap in RESULT_RE.captures_iter(&text) {
        if hits.len() >= n {
            break;
        }
        let href = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let title_html = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let snippet_html = cap.get(3).map(|m| m.as_str()).unwrap_or("");
        hits.push(WebSearchHit {
            url: unwrap_ddg_redirect(href),
            title: strip_tags(title_html),
            snippet: strip_tags(snippet_html),
        });
    }

    // Search snippets are untrusted attacker-controlled text — concat and
    // scan. If any hits contain injection patterns we re-wrap the
    // *individual* offending snippets so the agent sees the DATA-only
    // markers right next to the bad string.
    let joined: String = hits
        .iter()
        .map(|h| h.snippet.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if !injection_scan::scan(&joined).is_empty() {
        for h in hits.iter_mut() {
            let (wrapped, n) = injection_scan::scan_and_wrap(&h.snippet);
            if n > 0 {
                h.snippet = wrapped;
            }
        }
    }

    Ok(WebSearchResult { query, hits })
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{:02X}", b);
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ── http_request (generic) ──────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct HttpReqInput {
    pub method: String,
    pub url: String,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct HttpResp {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub bytes: u64,
    pub truncated: bool,
}

pub async fn http_request(input: HttpReqInput) -> Result<HttpResp, String> {
    let method = input.method.to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) {
        return Err(err_string(ToolError::invalid(format!(
            "method not allowed: {method}"
        ))));
    }
    let url = url::Url::parse(&input.url)
        .map_err(|e| err_string(ToolError::invalid(format!("bad url: {e}"))))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(err_string(ToolError::invalid("only http(s) urls allowed")));
    }
    let host = url.host_str().unwrap_or("").to_string();
    if !is_safe_public_host(&host) {
        return Err(err_string(ToolError::Protected {
            message: format!("host '{host}' is private/loopback — blocked (SSRF)"),
        }));
    }
    let default_port = url.port_or_known_default().unwrap_or(443);
    let safe_addrs = resolve_to_safe_addrs(&host, default_port).await?;
    let timeout = std::time::Duration::from_secs(input.timeout_secs.unwrap_or(15).min(60));
    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("Froglips/0.9 (+https://github.com/Jeritano/FrogLips)")
        .redirect(ssrf_safe_redirect());
    for a in &safe_addrs {
        client_builder = client_builder.resolve_to_addrs(&host, &[*a]);
    }
    let client = client_builder
        .build()
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    let method_obj = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| err_string(ToolError::invalid(e.to_string())))?;
    let mut req = client.request(method_obj, url);
    if let Some(hm) = input.headers {
        for (k, v) in hm {
            if k.is_empty() || k.len() > 256 || v.len() > 4096 {
                return Err(err_string(ToolError::invalid(
                    "header key/value out of range",
                )));
            }
            // Block headers that could enable bypass of our SSRF guard (Host
            // override on a CDN, for example).
            let kl = k.to_ascii_lowercase();
            if kl == "host" {
                return Err(err_string(ToolError::invalid(
                    "Host header override not allowed",
                )));
            }
            req = req.header(k, v);
        }
    }
    if let Some(b) = input.body {
        if b.len() > 1_048_576 {
            return Err(err_string(ToolError::TooLarge {
                message: "body exceeds 1 MiB".into(),
            }));
        }
        req = req.body(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    let status = resp.status().as_u16();
    let mut hdrs = std::collections::HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            hdrs.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let (bytes, total, truncated) = read_capped(resp, WEB_FETCH_MAX_BYTES).await?;
    let body = String::from_utf8_lossy(&bytes).into_owned();

    // Only scan responses that are likely human-readable text — binary
    // payloads (images, archives) would just trip false positives or
    // waste cycles. Bound at < 1 MiB (the same cap we used to read), and
    // require a text-ish Content-Type header.
    let ct = hdrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();
    let text_like = ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("xml")
        || ct.contains("html")
        || ct.contains("javascript")
        || ct.contains("yaml")
        || ct.is_empty(); // unknown → treat as text, the body is already UTF-8 lossy
    let body = if text_like && body.len() < WEB_FETCH_MAX_BYTES {
        injection_scan::scan_and_wrap(&body).0
    } else {
        body
    };

    Ok(HttpResp {
        status,
        headers: hdrs,
        body,
        bytes: total,
        truncated,
    })
}

/// Risk heuristic for HTTP requests beyond GET/HEAD. Read-only methods are
/// the floor; writes are flagged as privileged so the confirm modal shows
/// a louder banner.
pub fn classify_http_risk(method: &str, has_auth: bool) -> &'static str {
    let m = method.to_ascii_uppercase();
    if matches!(m.as_str(), "DELETE" | "PUT" | "PATCH") {
        return "destructive";
    }
    if m == "POST" {
        return if has_auth { "privileged" } else { "normal" };
    }
    "normal"
}
