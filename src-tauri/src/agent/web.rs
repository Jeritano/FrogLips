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
// Larger read cap for the web_search parse path. The DDG HTML is parsed for
// result blocks and never returned wholesale, so a bigger cap costs only
// transient memory while ensuring the first `n` `result__a` blocks aren't
// clipped mid-tag by the 1 MiB body cap (bug: silent mid-result truncation of
// a structured parse — the result blocks sit early but the page can exceed
// 1 MiB once footer/scripts are counted). Still bounded so a hostile/huge
// page can't OOM us.
const WEB_SEARCH_MAX_BYTES: usize = 4 * 1_048_576; // 4 MiB

pub fn is_safe_public_host(host: &str) -> bool {
    // Reject localhost + RFC1918 + link-local + .local — defends against SSRF.
    let h0 = host.to_ascii_lowercase();
    // Strip a single trailing dot: `localhost.` / `foo.local.` are valid FQDN
    // forms that resolve identically but would slip the string comparisons below.
    let h = h0.strip_suffix('.').unwrap_or(&h0);
    if h.is_empty() || h == "localhost" || h.ends_with(".local") || h.ends_with(".internal") {
        return false;
    }
    // Sec audit (2026-06): `url::Url::host_str()` returns IPv6 literals WITH
    // brackets ("[::1]", "[::ffff:169.254.169.254]"). Without stripping them the
    // parse below fails and the fn falls through to `true` — classifying a
    // loopback/metadata IPv6 literal as a safe public host. Strip the brackets
    // before parsing so IP-literal hosts always hit `is_safe_ip`.
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
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
        || oct[0] == 127
        // CGNAT 100.64.0.0/10 — covers Alibaba Cloud's metadata endpoint
        // 100.100.100.200, matching the MCP remote-URL guard
        // (mcp::is_blocked_ip). `is_private()` does NOT cover CGNAT.
        || (oct[0] == 100 && (oct[1] & 0xc0) == 0x40)
        // Audit A29: reserved/non-global ranges std's predicates miss —
        // 240.0.0.0/4 (reserved/future), 198.18.0.0/15 (benchmarking, RFC2544),
        // 192.0.0.0/24 (IETF protocol assignments). Block them too so an SSRF
        // target can't reach a non-routable/reserved address.
        || (oct[0] >= 240)
        || (oct[0] == 198 && (oct[1] == 18 || oct[1] == 19))
        || (oct[0] == 192 && oct[1] == 0 && oct[2] == 0))
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
            // PREFIX-mask checks, not exact equality. SEC-MED (2026-05-30):
            // `segs[0] == 0xfc00 || == 0xfd00` missed virtually every real ULA
            // (fc00::/7 carries a random 40-bit global id, so the first segment
            // is almost never exactly fc00/fd00), and `== 0xfe80` missed
            // fe81..febf — an SSRF bypass to internal IPv6 services. Mirrors the
            // correct masked check in custom_backend.rs.
            !(a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (segs[0] & 0xffc0) == 0xfe80  // link-local fe80::/10
                || (segs[0] & 0xfe00) == 0xfc00) // unique-local fc00::/7 (incl. fd00::/8)
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

/// Headers an agent must never set on an outbound request:
///   1. Auth/cookies — the model smuggling its own credentials.
///   2. Forwarded-for/host overrides — CDNs/proxies trust these for routing
///      and origin decisions; spoofing them impersonates clients or escapes
///      the SSRF guard at the next hop.
///   3. Origin/Referer/User-Agent + Sec-Fetch-* — browser-session spoofing
///      (naive CSRF bypass, GoogleBot impersonation, provenance lies).
const DENY_HEADERS: &[&str] = &[
    "host",
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "referer",
    "origin",
    "user-agent",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
];

/// Reject model-supplied headers that are oversized or on the deny list.
/// Shared by `http_request` and `call_api` so the two paths can't drift.
fn validate_outbound_headers(
    headers: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    for (k, v) in headers {
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
    Ok(())
}

/// Build a reqwest client that follows NO redirects and pins DNS for `host`
/// to exactly the pre-validated `safe_addrs`. Each redirect hop gets its own
/// freshly-built client so the connection can only ever land on an address
/// we resolved-and-validated for that specific host — closing the
/// DNS-rebinding TOCTOU where reqwest's auto-follow would re-resolve at
/// connect time and reach 127.0.0.1 / 169.254.169.254.
fn build_pinned_no_redirect_client(
    host: &str,
    safe_addrs: &[std::net::SocketAddr],
    timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    // Route through the anonymizing proxy (if configured) + a generic,
    // non-identifying User-Agent (no "Froglips/0.x" fingerprint).
    let mut b = crate::net::client_builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());
    // The SSRF address-pin only applies on a DIRECT connection. Through a proxy
    // the proxy resolves + connects, so a local resolve override is inert — and
    // a Tor exit can't reach the user's LAN regardless. The host was already
    // validated as public upstream, so skipping the pin when proxied is safe.
    if !crate::net::proxy_enabled() {
        for a in safe_addrs {
            b = b.resolve_to_addrs(host, &[*a]);
        }
    }
    b.build()
        .map_err(|e| err_string(ToolError::io(e.to_string())))
}

/// Pinned-client cache (perf review, mirrors custom_backend.rs's
/// PINNED_CLIENT_CACHE). Rebuilding a reqwest client per hop re-ran TLS from
/// scratch and reused no connection pool across agent tool calls — ~30-120ms
/// per send even in the common zero-redirect case. We still RESOLVE + VALIDATE
/// the host on every call (the redirect loop below does that before reaching
/// here); we only reuse the *built* client+pool, keyed by host + the exact
/// sorted validated address set + timeout. Because the pin travels with the
/// cached client, a cache hit can only ever connect to the addresses it was
/// validated against, so the SSRF posture is unchanged and the rebind window
/// stays bounded by `PINNED_CLIENT_TTL`.
static PINNED_CLIENT_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, reqwest::Client)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const PINNED_CLIENT_TTL: std::time::Duration = std::time::Duration::from_secs(60);

fn pinned_no_redirect_client(
    host: &str,
    safe_addrs: &[std::net::SocketAddr],
    timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    // Key on host + sorted validated addrs + timeout so a hit can only reuse a
    // client pinned to the exact same address set the caller just validated.
    let mut sorted: Vec<std::net::SocketAddr> = safe_addrs.to_vec();
    sorted.sort();
    let key = {
        use std::fmt::Write;
        let mut k = format!("{host}|{}|", timeout.as_millis());
        for a in &sorted {
            let _ = write!(k, "{a},");
        }
        k
    };
    if let Ok(cache) = PINNED_CLIENT_CACHE.lock() {
        if let Some((built, client)) = cache.get(&key) {
            if built.elapsed() < PINNED_CLIENT_TTL {
                return Ok(client.clone());
            }
        }
    }
    let client = build_pinned_no_redirect_client(host, safe_addrs, timeout)?;
    if let Ok(mut cache) = PINNED_CLIENT_CACHE.lock() {
        // Opportunistic sweep so transient hosts don't accumulate stale pools.
        cache.retain(|_, (built, _)| built.elapsed() < PINNED_CLIENT_TTL);
        cache.insert(key, (std::time::Instant::now(), client.clone()));
    }
    Ok(client)
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
    // Read with the larger search cap so the structured `result__a` parse below
    // can't be clipped mid-tag (which would silently drop the final hit). The
    // body is parsed, never returned wholesale, so the larger cap is parse-only.
    let (bytes, _total, _truncated) = read_capped(resp, WEB_SEARCH_MAX_BYTES).await?;
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
        let url = unwrap_ddg_redirect(href);
        // The result URL comes from attacker-influenceable DDG markup. Only
        // surface http(s) results to a safe public host so we never hand the
        // model a `file://` or internal-IP "result" to fetch (sec review
        // 2026-06 MED). web_fetch re-validates with resolve+pin at fetch time;
        // this string-level filter stops bad URLs from being surfaced at all.
        let url_ok = url::Url::parse(&url).ok().is_some_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().map(is_safe_public_host).unwrap_or(false)
        });
        if !url_ok {
            continue;
        }
        hits.push(WebSearchHit {
            url,
            title: strip_tags(title_html),
            snippet: strip_tags(snippet_html),
        });
    }

    // Search titles + snippets are untrusted attacker-controlled text — concat
    // and scan. If any hit contains injection patterns we re-wrap the
    // *individual* offending fields so the agent sees the DATA-only markers
    // right next to the bad string. Sec audit round 7: the page `<title>` is as
    // attacker-controlled as the snippet, so fence it too (was previously
    // unwrapped while the snippet was).
    let joined: String = hits
        .iter()
        .flat_map(|h| [h.title.as_str(), h.snippet.as_str()])
        .collect::<Vec<_>>()
        .join("\n");
    if !injection_scan::scan(&joined).is_empty() {
        for h in hits.iter_mut() {
            let (ws, ns) = injection_scan::scan_and_wrap(&h.snippet);
            if ns > 0 {
                h.snippet = ws;
            }
            let (wt, nt) = injection_scan::scan_and_wrap(&h.title);
            if nt > 0 {
                h.title = wt;
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
    validate_outbound_headers(&headers)?;
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
                          // Audit A32: `<=` not `<` — read_capped fills to EXACTLY the cap, so a
                          // maximal attacker-chosen body landing on the boundary must still be scanned.
    let body = if text_like && body.len() <= WEB_FETCH_MAX_BYTES {
        injection_scan::scan_and_wrap(&body).0
    } else {
        body
    };
    // Sec audit round 6: response header VALUES are attacker-controlled too, so
    // fence each like the body — a header such as `X-Note: ignore previous
    // instructions…` would otherwise reach the model unfenced. No-op unless a
    // pattern is detected (scan_and_wrap returns the value unchanged otherwise).
    let headers: std::collections::HashMap<String, String> = hdrs
        .into_iter()
        .map(|(k, v)| (k, injection_scan::scan_and_wrap(&v).0))
        .collect();

    Ok(HttpResp {
        status,
        headers,
        body,
        bytes: total,
        truncated,
    })
}

/* ── call_api (saved-API registry) ───────────────────────────────────────── */

#[derive(Deserialize)]
pub struct CallApiInput {
    /// The SavedApi id (or name) the user registered.
    pub api: String,
    pub method: String,
    /// Path appended to the API's base_url, e.g. "/repos/owner/name/issues".
    /// Absolute URLs are rejected — the agent stays confined to the base host.
    pub path: String,
    pub query: Option<std::collections::HashMap<String, String>>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_secs: Option<u64>,
}

/// Call a user-registered API by name. The stored key is injected into the
/// auth header SERVER-SIDE (the model never sees it), the request is confined
/// to the registered base host, and it rides the same SSRF-guarded,
/// DNS-pinned, injection-scanned path as `http_request`. The model picks the
/// API + relative path; everything secret or security-sensitive (the key, the
/// host) is fixed by the user's registration.
pub async fn call_api(input: CallApiInput) -> Result<HttpResp, String> {
    let apis = crate::settings::load().saved_apis.unwrap_or_default();
    let api = apis
        .iter()
        .find(|a| a.id == input.api || a.name.eq_ignore_ascii_case(&input.api))
        .ok_or_else(|| {
            err_string(ToolError::invalid(format!(
                "no saved API named '{}' — registered: [{}]",
                input.api,
                apis.iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )))
        })?;

    // Resolve the full URL from base_url + path. Reject an absolute path so
    // the model can't escape the registered host.
    if input.path.contains("://") {
        return Err(err_string(ToolError::invalid(
            "path must be relative to the API base_url, not an absolute URL",
        )));
    }
    let base = api.base_url.trim_end_matches('/');
    let rel = input.path.trim_start_matches('/');
    let mut url = url::Url::parse(&format!("{base}/{rel}"))
        .map_err(|e| err_string(ToolError::invalid(format!("bad url: {e}"))))?;
    if let Some(q) = &input.query {
        for (k, v) in q {
            url.query_pairs_mut().append_pair(k, v);
        }
    }
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(err_string(ToolError::invalid("only http(s) urls allowed")));
    }
    let host = url.host_str().unwrap_or("").to_string();
    if !is_safe_public_host(&host) {
        return Err(err_string(ToolError::Protected {
            message: format!("host '{host}' is private/loopback — blocked (SSRF)"),
        }));
    }

    let method = input.method.to_ascii_uppercase();
    let method_obj = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| err_string(ToolError::invalid(e.to_string())))?;
    let timeout = std::time::Duration::from_secs(input.timeout_secs.unwrap_or(15).min(60));

    // Model-supplied headers get the SAME deny-list + length bounds as
    // http_request (sec review 2026-06-11 #2 — the old code only blocked the
    // auth header name, letting the model spoof Host / X-Forwarded-For /
    // Cookie / Origin onto a CREDENTIALED request).
    let model_headers = input.headers.unwrap_or_default();
    validate_outbound_headers(&model_headers)?;
    if model_headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case(&api.auth_header))
    {
        return Err(err_string(ToolError::invalid(
            "the auth header is set automatically — do not pass it",
        )));
    }
    let auth_value = api.api_key.as_deref().map(|key| {
        if api.auth_template.contains("{key}") {
            api.auth_template.replace("{key}", key)
        } else {
            format!("{} {}", api.auth_template, key)
        }
    });
    let auth_header_name = api.auth_header.clone();
    // The registered host — auth is attached ONLY when a (redirect) hop stays
    // on it (sec review 2026-06-11 #1 — the manual redirect follower re-ran
    // the closure per hop and re-attached the key even cross-host, so an
    // open-redirect on the registered API could bounce the user's real key to
    // an attacker host; reqwest's own follower strips Authorization
    // cross-origin for exactly this reason).
    let registered_host = host.to_ascii_lowercase();
    let body = match input.body {
        Some(b) if b.len() > 1_048_576 => {
            return Err(err_string(ToolError::TooLarge {
                message: "body exceeds 1 MiB".into(),
            }))
        }
        other => other,
    };

    let resp = send_following_redirects(url.clone(), timeout, |client, u| {
        let mut req = client.request(method_obj.clone(), u.clone());
        for (k, v) in &model_headers {
            req = req.header(k, v);
        }
        let same_host = u
            .host_str()
            .map(|h| h.eq_ignore_ascii_case(&registered_host))
            .unwrap_or(false);
        // Audit A17: host-only was not enough — a same-host https→http
        // downgrade redirect re-sent the bearer key in CLEARTEXT. Attach auth
        // only on a same-host hop that is https, OR http to a loopback host
        // (local APIs). Never attach the key to a plaintext http hop on a
        // non-loopback host.
        let host_is_loopback = u
            .host_str()
            .map(|h| {
                h.eq_ignore_ascii_case("localhost")
                    || h == "127.0.0.1"
                    || h == "::1"
                    || h.eq_ignore_ascii_case("[::1]")
            })
            .unwrap_or(false);
        let auth_safe_hop = u.scheme() == "https" || (u.scheme() == "http" && host_is_loopback);
        if same_host && auth_safe_hop {
            if let Some(av) = &auth_value {
                req = req.header(auth_header_name.as_str(), av);
            }
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
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    // Redact the injected secret if the API reflects it back (sec review
    // 2026-06-11 #3 — header-echo endpoints like httpbin /headers would
    // otherwise hand the key straight to the model).
    // Best-effort: redact the key (and the full auth header value) if the API
    // reflects it back. Covers the common base64 echo too (JSON fields, Basic
    // auth) — not every possible transform, but the realistic ones. Min length 8
    // guards against over-redacting unrelated short/common substrings (sec review
    // 2026-06).
    let redact = |s: String| -> String {
        use base64::Engine;
        let mut out = s;
        if let Some(av) = &auth_value {
            if av.len() >= 8 {
                out = out.replace(av.as_str(), "<redacted>");
            }
        }
        if let Some(key) = api.api_key.as_deref() {
            if key.len() >= 8 {
                for rep in [
                    key.to_string(),
                    base64::engine::general_purpose::STANDARD.encode(key),
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
                ] {
                    out = out.replace(&rep, "<redacted>");
                }
            }
        }
        out
    };
    let body = redact(injection_scan::scan_and_wrap(&raw).0);
    let headers: std::collections::HashMap<String, String> = hdrs
        .into_iter()
        .map(|(k, v)| (k, redact(injection_scan::scan_and_wrap(&v).0)))
        .collect();
    Ok(HttpResp {
        status,
        headers,
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
    fn outbound_header_validator_blocks_spoofable_headers() {
        // Post-bump review #2 (2026-06-11): call_api must enforce the same
        // deny list as http_request so the model can't spoof Host /
        // X-Forwarded-For / Cookie / Origin onto a credentialed request.
        let mut h = std::collections::HashMap::new();
        h.insert("X-Custom".into(), "ok".into());
        assert!(validate_outbound_headers(&h).is_ok());
        for bad in [
            "Host",
            "host",
            "X-Forwarded-For",
            "Cookie",
            "Authorization",
            "Origin",
            "User-Agent",
        ] {
            let mut h = std::collections::HashMap::new();
            h.insert(bad.to_string(), "x".into());
            assert!(
                validate_outbound_headers(&h).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
        // Oversized value rejected.
        let mut big = std::collections::HashMap::new();
        big.insert("X-Big".into(), "a".repeat(4097));
        assert!(validate_outbound_headers(&big).is_err());
    }

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

    #[test]
    fn ipv6_ula_and_linklocal_rejected_via_prefix_mask() {
        // SEC-MED (2026-05-30): the old exact-equality check missed these.
        // Unique-local fc00::/7 with a realistic random global id:
        assert!(!is_safe_public_host("fd12:3456:789a::1"));
        assert!(!is_safe_public_host("fdab::1"));
        assert!(!is_safe_public_host("fc01::1"));
        // Link-local fe80::/10 beyond the exact fe80 segment:
        assert!(!is_safe_public_host("fe81::1"));
        assert!(!is_safe_public_host("feb0::1"));
        // Public IPv6 must still be allowed (not over-blocked by the mask).
        assert!(is_safe_public_host("2001:4860:4860::8888")); // Google DNS
        assert!(is_safe_public_host("2606:2800:220:1:248:1893:25c8:1946"));
        // Bracketed IPv6 literals (as url::Url::host_str returns them) must be
        // parsed + blocked, not fall through to "safe". Sec audit (2026-06).
        assert!(!is_safe_public_host("[::1]"));
        assert!(!is_safe_public_host("[::ffff:169.254.169.254]"));
        assert!(!is_safe_public_host("[fd00::1]"));
        assert!(is_safe_public_host("[2001:4860:4860::8888]")); // public, bracketed
    }
}
