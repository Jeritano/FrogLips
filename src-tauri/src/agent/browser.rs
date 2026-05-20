//! Browser automation tools (CDP via `chromiumoxide`).
//!
//! Gated behind the `browser-automation` Cargo feature. When the feature is
//! off, every entry point returns a polite error so the rest of the build is
//! unaffected.
//!
//! ## Safety model
//!
//! - URLs passed to `browser_navigate` must pass the same SSRF allowlist used
//!   by `agent::web::web_fetch`: no loopback / RFC1918 / link-local / `.local`
//!   / `.internal` hosts, and the hostname must resolve to addresses that all
//!   fall in safe ranges. Closes the obvious "drive the agent to
//!   `http://localhost:1313/admin` and click stuff" hole.
//! - The browser binary is **not** bundled — chromiumoxide spawns whatever
//!   Chrome/Chromium it finds on `PATH`. The tool description surfaces this.
//! - One persistent browser instance per process. The page is treated like a
//!   REPL — agent can navigate, click, fill, screenshot. `browser_close`
//!   drops the instance. The Tauri exit handler also force-closes on app
//!   shutdown via [`shutdown_browser`].
//! - There is no escape hatch. No `skip_safety`, no `--no-sandbox` flag
//!   plumbed in, no localhost override.

use serde::Serialize;

use super::fs::{err_string, ToolError};

#[derive(Serialize, Debug)]
pub struct BrowserNavigateResult {
    pub status: u16,
    pub title: String,
    pub url: String,
    /// PNG screenshot of the loaded page, base64-encoded. Empty on disabled
    /// builds.
    pub screenshot_base64: String,
}

#[derive(Serialize, Debug)]
pub struct BrowserOkResult {
    pub ok: bool,
}

#[derive(Serialize, Debug)]
pub struct BrowserScreenshotResult {
    pub base64: String,
}

#[derive(Serialize, Debug)]
pub struct BrowserTextResult {
    pub text: String,
}

// ─── SSRF pre-flight (shared between enabled / disabled builds so tests can
// exercise it without compiling chromiumoxide) ─────────────────────────────

/// Pre-flight check for a URL the agent wants to navigate to. Re-uses the
/// same allowlist that `web_fetch` enforces. Returns `Ok(())` if the URL is
/// safe to hand off to CDP, otherwise a user-facing error string.
#[allow(dead_code)] // tests + enabled-backend reach this; disabled-backend doesn't.
pub async fn validate_navigate_url(url_str: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(url_str)
        .map_err(|e| err_string(ToolError::invalid(format!("bad url: {e}"))))?;
    // CDP can drive `file://`, `chrome://`, `data:` URLs to bypass network —
    // restrict to http(s) and data: (data: is harmless, useful for tests).
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("").to_string();
            if !super::web::is_safe_public_host(&host) {
                return Err(err_string(ToolError::Protected {
                    message: format!(
                        "host '{host}' is private/loopback/link-local — blocked to prevent SSRF"
                    ),
                }));
            }
            let port = url.port_or_known_default().unwrap_or(443);
            // Resolve and verify every A/AAAA record lands in a safe range.
            super::web::resolve_to_safe_addrs(&host, port).await?;
        }
        "data" => {
            // data: URLs carry their payload inline; no network reach.
        }
        other => {
            return Err(err_string(ToolError::invalid(format!(
                "scheme '{other}' not allowed (use http/https/data:)"
            ))));
        }
    }
    Ok(url)
}

#[cfg(feature = "browser-automation")]
mod backend {
    use super::*;
    use chromiumoxide::browser::{Browser, BrowserConfig};
    use chromiumoxide::page::Page;
    use futures_util::StreamExt;
    use once_cell::sync::Lazy;
    use std::time::Duration;
    use tokio::sync::Mutex;

    struct Session {
        browser: Browser,
        page: Page,
        /// Detached handler task we need to drop on close so the websocket
        /// pump shuts down cleanly.
        handler: tokio::task::JoinHandle<()>,
    }

    static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

    async fn ensure_session() -> Result<tokio::sync::MutexGuard<'static, Option<Session>>, String> {
        let mut guard = SESSION.lock().await;
        if guard.is_none() {
            let config = BrowserConfig::builder()
                .request_timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| err_string(ToolError::io(format!("browser config: {e}"))))?;
            let (browser, mut handler) = Browser::launch(config).await.map_err(|e| {
                err_string(ToolError::io(format!(
                    "could not launch Chrome (is it installed and on PATH?): {e}"
                )))
            })?;
            let task = tokio::spawn(async move {
                while let Some(ev) = handler.next().await {
                    // Swallow handler errors — they'd otherwise spam the log
                    // and the browser becomes unusable anyway when the
                    // underlying ws goes away.
                    let _ = ev;
                }
            });
            let page = browser
                .new_page("about:blank")
                .await
                .map_err(|e| err_string(ToolError::io(format!("new page: {e}"))))?;
            *guard = Some(Session {
                browser,
                page,
                handler: task,
            });
        }
        Ok(guard)
    }

    pub async fn navigate(url_str: String) -> Result<BrowserNavigateResult, String> {
        let url = validate_navigate_url(&url_str).await?;
        let mut guard = ensure_session().await?;
        let session = guard.as_mut().expect("session present after ensure");
        let resp = session
            .page
            .goto(url.as_str())
            .await
            .map_err(|e| err_string(ToolError::io(format!("navigate: {e}"))))?;
        let _ = resp
            .wait_for_navigation()
            .await
            .map_err(|e| err_string(ToolError::io(format!("wait nav: {e}"))))?;
        let title = session
            .page
            .get_title()
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        let landed = session
            .page
            .url()
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| url.to_string());
        // Best-effort response status — chromiumoxide doesn't surface this
        // from `goto` cleanly without subscribing to Network events first.
        // Report 200 for http(s) (page loaded) and 0 for non-network schemes.
        let status = if url.scheme() == "data" { 0 } else { 200 };
        let png = session
            .page
            .screenshot(chromiumoxide::page::ScreenshotParams::default())
            .await
            .unwrap_or_default();
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(BrowserNavigateResult {
            status,
            title,
            url: landed,
            screenshot_base64: b64,
        })
    }

    pub async fn click(selector: String) -> Result<BrowserOkResult, String> {
        let mut guard = ensure_session().await?;
        let session = guard.as_mut().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no browser session — call browser_navigate first",
            ))
        })?;
        let el = session
            .page
            .find_element(selector.clone())
            .await
            .map_err(|e| {
                err_string(ToolError::invalid(format!(
                    "selector '{selector}' not found: {e}"
                )))
            })?;
        el.click()
            .await
            .map_err(|e| err_string(ToolError::io(format!("click: {e}"))))?;
        Ok(BrowserOkResult { ok: true })
    }

    pub async fn fill(selector: String, value: String) -> Result<BrowserOkResult, String> {
        let mut guard = ensure_session().await?;
        let session = guard.as_mut().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no browser session — call browser_navigate first",
            ))
        })?;
        let el = session
            .page
            .find_element(selector.clone())
            .await
            .map_err(|e| {
                err_string(ToolError::invalid(format!(
                    "selector '{selector}' not found: {e}"
                )))
            })?;
        el.click()
            .await
            .map_err(|e| err_string(ToolError::io(format!("focus: {e}"))))?;
        el.type_str(&value)
            .await
            .map_err(|e| err_string(ToolError::io(format!("type: {e}"))))?;
        Ok(BrowserOkResult { ok: true })
    }

    pub async fn screenshot() -> Result<BrowserScreenshotResult, String> {
        let mut guard = ensure_session().await?;
        let session = guard.as_mut().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no browser session — call browser_navigate first",
            ))
        })?;
        let png = session
            .page
            .screenshot(chromiumoxide::page::ScreenshotParams::default())
            .await
            .map_err(|e| err_string(ToolError::io(format!("screenshot: {e}"))))?;
        use base64::Engine;
        Ok(BrowserScreenshotResult {
            base64: base64::engine::general_purpose::STANDARD.encode(png),
        })
    }

    pub async fn get_text(selector: Option<String>) -> Result<BrowserTextResult, String> {
        let mut guard = ensure_session().await?;
        let session = guard.as_mut().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no browser session — call browser_navigate first",
            ))
        })?;
        let sel = selector.unwrap_or_else(|| "body".into());
        let el = session.page.find_element(sel.clone()).await.map_err(|e| {
            err_string(ToolError::invalid(format!(
                "selector '{sel}' not found: {e}"
            )))
        })?;
        let text = el
            .inner_text()
            .await
            .map_err(|e| err_string(ToolError::io(format!("inner_text: {e}"))))?
            .unwrap_or_default();
        // Cap the response so a giant page doesn't blow the context.
        const MAX: usize = 65_536;
        let truncated_text = if text.len() > MAX {
            format!("{}…[truncated {} bytes]", &text[..MAX], text.len() - MAX)
        } else {
            text
        };
        Ok(BrowserTextResult {
            text: truncated_text,
        })
    }

    pub async fn close() -> Result<BrowserOkResult, String> {
        let mut guard = SESSION.lock().await;
        if let Some(mut session) = guard.take() {
            let _ = session.browser.close().await;
            let _ = session.browser.wait().await;
            session.handler.abort();
        }
        Ok(BrowserOkResult { ok: true })
    }

    pub async fn shutdown() {
        let mut guard = SESSION.lock().await;
        if let Some(mut session) = guard.take() {
            let _ = session.browser.close().await;
            let _ = session.browser.wait().await;
            session.handler.abort();
        }
    }
}

#[cfg(not(feature = "browser-automation"))]
mod backend {
    use super::*;

    fn disabled<T>() -> Result<T, String> {
        Err(err_string(ToolError::invalid(
            "browser automation not enabled in this build — rebuild with --features browser-automation and ensure Chrome/Chromium is installed",
        )))
    }

    pub async fn navigate(_url: String) -> Result<BrowserNavigateResult, String> {
        disabled()
    }
    pub async fn click(_selector: String) -> Result<BrowserOkResult, String> {
        disabled()
    }
    pub async fn fill(_selector: String, _value: String) -> Result<BrowserOkResult, String> {
        disabled()
    }
    pub async fn screenshot() -> Result<BrowserScreenshotResult, String> {
        disabled()
    }
    pub async fn get_text(_selector: Option<String>) -> Result<BrowserTextResult, String> {
        disabled()
    }
    pub async fn close() -> Result<BrowserOkResult, String> {
        Ok(BrowserOkResult { ok: true })
    }
    pub async fn shutdown() {}
}

pub use backend::{click, close, fill, get_text, navigate, screenshot, shutdown};

#[cfg(test)]
mod tests {
    use super::*;

    /// SSRF pre-flight rejects loopback URLs regardless of whether the
    /// browser feature is on. Runs in both build configurations.
    #[tokio::test]
    async fn rejects_loopback_url() {
        let err = validate_navigate_url("http://127.0.0.1/admin")
            .await
            .unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("loopback"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_localhost_url() {
        let err = validate_navigate_url("http://localhost:8080/")
            .await
            .unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("loopback"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_dotlocal_url() {
        let err = validate_navigate_url("http://router.local/")
            .await
            .unwrap_err();
        assert!(
            err.to_lowercase().contains("private") || err.to_lowercase().contains("loopback"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_file_scheme() {
        let err = validate_navigate_url("file:///etc/passwd")
            .await
            .unwrap_err();
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_chrome_scheme() {
        let err = validate_navigate_url("chrome://settings")
            .await
            .unwrap_err();
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[tokio::test]
    async fn accepts_data_url() {
        let url = validate_navigate_url("data:text/html,<title>hi</title>")
            .await
            .unwrap();
        assert_eq!(url.scheme(), "data");
    }

    /// Navigate to a `data:` URL and confirm the title parses. Avoids any
    /// real-network dependence. Only runs when the feature is enabled AND a
    /// Chrome binary is reachable — otherwise we skip the network/IO half
    /// and just check the validator path.
    #[cfg(feature = "browser-automation")]
    #[tokio::test]
    async fn navigate_data_url_title() {
        // Only attempt if Chrome appears installed; otherwise this would
        // fail in CI and provide no signal.
        if which_chrome().is_none() {
            eprintln!("skipping: no chrome/chromium binary on PATH");
            return;
        }
        let res = navigate("data:text/html,<title>hi</title><body>x".into()).await;
        // Tear down regardless of outcome so other tests aren't affected.
        let _ = close().await;
        let r = res.expect("navigate should succeed for data: URL");
        assert_eq!(r.title, "hi");
    }

    #[cfg(feature = "browser-automation")]
    fn which_chrome() -> Option<std::path::PathBuf> {
        for candidate in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            let p = std::path::Path::new(candidate);
            if p.is_absolute() && p.exists() {
                return Some(p.to_path_buf());
            }
            if let Ok(path) = std::env::var("PATH") {
                for dir in path.split(':') {
                    let pp = std::path::Path::new(dir).join(candidate);
                    if pp.exists() {
                        return Some(pp);
                    }
                }
            }
        }
        None
    }
}
