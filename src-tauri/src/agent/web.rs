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
        // Reuse the connect-time IP check so IP-literal hosts (incl.
        // IPv4-mapped V6 and NAT64) get the exact same treatment.
        return is_safe_ip(&ip);
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
fn is_safe_v4(a: &std::net::Ipv4Addr) -> bool {
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

fn is_safe_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => is_safe_v4(a),
        std::net::IpAddr::V6(a) => {
            let segs = a.segments();
            // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible forms tunnel a
            // V4 address through V6 — re-run the V4 checks so e.g.
            // `::ffff:127.0.0.1` cannot pass as a "safe" V6 literal.
            if let Some(v4) = a.to_ipv4_mapped().or_else(|| a.to_ipv4()) {
                if !is_safe_v4(&v4) {
                    return false;
                }
            }
            // NAT64 well-known prefix 64:ff9b::/96 embeds an arbitrary V4
            // address translators will reach — block outright.
            if segs[0] == 0x0064 && segs[1] == 0xff9b {
                return false;
            }
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

/// Max redirect hops we follow manually. Matches the old `Policy::limited(5)`.
const MAX_REDIRECT_HOPS: usize = 5;

/// Build a reqwest client that follows NO redirects and pins DNS for `host`
/// to exactly the pre-validated `safe_addrs`. Each redirect hop gets its own
/// freshly-built client so the connection can only ever land on an address
/// we resolved-and-validated for that specific host — closing the
/// DNS-rebinding TOCTOU where reqwest's auto-follow would re-resolve at
/// connect time and reach 127.0.0.1 / 169.254.169.254.
fn pinned_no_redirect_client(
    host: &str,
    safe_addrs: &[std::net::SocketAddr],
    timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("Froglips/0.9 (+https://github.com/Jeritano/FrogLips)")
        .redirect(reqwest::redirect::Policy::none());
    for a in safe_addrs {
        b = b.resolve_to_addrs(host, &[*a]);
    }
    b.build()
        .map_err(|e| err_string(ToolError::io(e.to_string())))
}

/// Manually follow redirects with per-hop SSRF validation + DNS pinning.
/// `build_req` is called for every hop to produce a fresh request against the
/// pinned client (so headers/method/body carry across as the caller intends).
/// Returns the final non-redirect response.
async fn send_following_redirects<F>(
    mut url: url::Url,
    timeout: std::time::Duration,
    build_req: F,
) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &url::Url) -> reqwest::RequestBuilder,
{
    for _hop in 0..=MAX_REDIRECT_HOPS {
        if url.scheme() != "https" && url.scheme() != "http" {
            return Err(err_string(ToolError::invalid(
                "redirect to non-http(s) scheme",
            )));
        }
        let host = url.host_str().unwrap_or("").to_string();
        if !is_safe_public_host(&host) {
            return Err(err_string(ToolError::Protected {
                message: format!("redirect host '{host}' is private/loopback — blocked (SSRF)"),
            }));
        }
        let port = url.port_or_known_default().unwrap_or(443);
        // Resolve-and-validate, then pin the connection to that exact set.
        let safe_addrs = resolve_to_safe_addrs(&host, port).await?;
        let client = pinned_no_redirect_client(&host, &safe_addrs, timeout)?;
        let resp = build_req(&client, &url)
            .send()
            .await
            .map_err(|e| err_string(ToolError::io(e.to_string())))?;
        if !resp.status().is_redirection() {
            return Ok(resp);
        }
        // Follow the Location header — resolve relative against current url.
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                err_string(ToolError::io("redirect response without Location header"))
            })?;
        url = url
            .join(loc)
            .map_err(|e| err_string(ToolError::invalid(format!("bad redirect Location: {e}"))))?;
    }
    Err(err_string(ToolError::invalid("too many redirects")))
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
    // Follow redirects manually: every hop is resolve-validated and the
    // connection pinned to that hop's validated IP set, so a rebinding DNS
    // cannot point the real connection at a loopback/metadata address.
    let timeout = std::time::Duration::from_secs(WEB_FETCH_TIMEOUT_SECS);
    let resp =
        send_following_redirects(url.clone(), timeout, |client, u| client.get(u.clone())).await?;
    let status = resp.status().as_u16();
    // Trust the server's Content-Type for HTML detection rather than peeking
    // at the body. Substring sniffing tripped on any page that merely
    // mentioned `<html>` in a code block, fed legitimate HTML through unchanged
    // when the body started with whitespace, and treated charset-suffixed
    // content-types inconsistently. The header is also already authoritative
    // for the http_request path — use the same signal here.
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let looks_html =
        content_type.contains("text/html") || content_type.contains("application/xhtml");

    let (bytes, total, truncated) = read_capped(resp, WEB_FETCH_MAX_BYTES).await?;
    let cap = bytes.len();
    let body_text = String::from_utf8_lossy(&bytes[..cap]).into_owned();

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
    // Route through the same hardened path web_fetch/http_request use: each
    // redirect hop is SSRF-validated and the connection DNS-pinned to a
    // pre-resolved safe address set, closing the rebinding TOCTOU that a
    // plain `redirect::Policy::limited` client leaves open.
    let url_str = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding(&query)
    );
    let url = url::Url::parse(&url_str)
        .map_err(|e| err_string(ToolError::invalid(format!("bad url: {e}"))))?;
    let timeout = std::time::Duration::from_secs(WEB_FETCH_TIMEOUT_SECS);
    let resp = send_following_redirects(url, timeout, |client, u| client.get(u.clone())).await?;
    let (bytes, _total, _truncated) = read_capped(resp, WEB_FETCH_MAX_BYTES).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();

    // Parse <a class="result__a" href="..."> + <a class="result__snippet">
    static RESULT_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(
            r#"(?s)<a\s+rel="nofollow"\s+class="result__a"\s+href="([^"]+)"[^>]*>(.*?)</a>.*?<a\s+class="result__snippet"[^>]*>(.*?)</a>"#
        ).unwrap()
    });
    fn strip_tags(s: &str) -> String {
        // Compile once, not per search hit (this runs up to 20×/search). (2026-05-30)
        static TAG_RE: once_cell::sync::Lazy<regex::Regex> =
            once_cell::sync::Lazy::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
        let no_tags = TAG_RE.replace_all(s, "");
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
    let timeout = std::time::Duration::from_secs(input.timeout_secs.unwrap_or(15).min(60));
    let method_obj = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| err_string(ToolError::invalid(e.to_string())))?;

    // Validate headers up front so a bad header fails before any network I/O.
    let headers = input.headers.unwrap_or_default();
    // Headers we refuse to let an agent set. Two categories:
    //   1. Authentication/cookies — the model should never be smuggling
    //      credentials of its own into outbound requests on the user's
    //      behalf, and any value here came from somewhere the agent
    //      shouldn't be reaching (the user, prior tool output, prompt).
    //   2. Forwarded-for/host overrides — front-end CDNs and reverse
    //      proxies trust these for routing/origin decisions; allowing the
    //      agent to set them lets it impersonate other clients or escape
    //      our SSRF guard at the next hop.
    const DENY_HEADERS: &[&str] = &[
        "host",
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-real-ip",
        // Sec review H6 — origin/referer/user-agent let the model spoof a
        // browser session: bypassing naive CSRF checks ("we only accept
        // requests with Origin: ourdomain.com"), impersonating GoogleBot
        // to scrape gated content, or evading rate-limit detection. The
        // Fetch metadata family (Sec-Fetch-*) tells the receiver this is
        // a browser-initiated request; forging them lies about provenance.
        "referer",
        "origin",
        "user-agent",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-fetch-user",
    ];
    for (k, v) in &headers {
        if k.is_empty() || k.len() > 256 || v.len() > 4096 {
            return Err(err_string(ToolError::invalid(
                "header key/value out of range",
            )));
        }
        if DENY_HEADERS.iter().any(|d| k.eq_ignore_ascii_case(d)) {
            return Err(err_string(ToolError::invalid(format!(
                "header '{k}' is not allowed"
            ))));
        }
    }
    let body = match input.body {
        Some(b) if b.len() > 1_048_576 => {
            return Err(err_string(ToolError::TooLarge {
                message: "body exceeds 1 MiB".into(),
            }))
        }
        other => other,
    };

    // Manual redirect following with per-hop DNS pinning (SSRF/TOCTOU).
    let resp = send_following_redirects(url.clone(), timeout, |client, u| {
        let mut req = client.request(method_obj.clone(), u.clone());
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        if let Some(b) = &body {
            req = req.body(b.clone());
        }
        req
    })
    .await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_mapped_v6_loopback_rejected() {
        // ::ffff:127.0.0.1 must be treated as loopback, not a safe V6 literal.
        // (url::Url strips the `[...]` brackets, so the host check sees the
        // bare literal — test that form.)
        assert!(!is_safe_public_host("::ffff:127.0.0.1"));
    }

    #[test]
    fn ipv4_mapped_v6_metadata_rejected() {
        // ::ffff:169.254.169.254 — cloud metadata via mapped form.
        assert!(!is_safe_public_host("::ffff:169.254.169.254"));
    }

    #[test]
    fn nat64_prefix_rejected() {
        // 64:ff9b::/96 embeds an arbitrary V4 a translator would reach.
        assert!(!is_safe_public_host("64:ff9b::7f00:1"));
    }

    #[test]
    fn ordinary_public_addrs_still_allowed() {
        assert!(is_safe_public_host("93.184.216.34")); // example.com
        assert!(is_safe_public_host("example.com"));
        assert!(is_safe_public_host("2606:2800:220:1:248:1893:25c8:1946"));
    }

    #[test]
    fn private_and_loopback_still_rejected() {
        assert!(!is_safe_public_host("127.0.0.1"));
        assert!(!is_safe_public_host("10.0.0.1"));
        assert!(!is_safe_public_host("169.254.169.254"));
        assert!(!is_safe_public_host("localhost"));
        assert!(!is_safe_public_host("::1"));
    }
}
