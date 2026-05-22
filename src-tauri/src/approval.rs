//! Capability-token gate for dangerous agent tool commands.
//!
//! The dangerous-tool confirmation modal lives in the frontend. Without a
//! backend check, any caller (a refactored call site, a new code path) could
//! invoke `agent_run_shell` / `agent_write_file` / `agent_applescript_run` /
//! `agent_http_request` and silently bypass the user gate.
//!
//! This module is a backstop: each dangerous command requires a single-use,
//! short-TTL token minted by `mint_tool_approval`, which is wired only from
//! the frontend's post-confirmation path. A new call site that forgets the
//! gate fails closed rather than running unconfirmed.
//!
//! Threat model: this defends against *accidental* bypass and refactor drift,
//! not a fully-compromised renderer — a hostile webview can call
//! `mint_tool_approval` itself. That is an inherent Tauri trust limit (the
//! renderer is in the trust boundary); closing it fully would need an
//! out-of-process broker. The gate's job here is to make the confirmation
//! step non-optional for honest code.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// How long a minted token stays valid before it is rejected as expired.
const TOKEN_TTL: Duration = Duration::from_secs(60);

struct TokenEntry {
    tool: String,
    minted: Instant,
}

static STORE: Lazy<Mutex<HashMap<String, TokenEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Generate a random opaque token string. Uses the process RNG via
/// `SystemTime` + an incrementing counter — tokens only need to be
/// unguessable enough that an honest caller can't collide, and single-use +
/// short-TTL bounds the window regardless.
fn random_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mix = nanos ^ ((n as u128) << 64) ^ (n as u128).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{mix:032x}")
}

/// Drop expired entries. Called opportunistically on mint/consume so the map
/// can't grow unbounded across a long app session.
fn gc(store: &mut HashMap<String, TokenEntry>) {
    let now = Instant::now();
    store.retain(|_, e| now.duration_since(e.minted) < TOKEN_TTL);
}

/// Mint a single-use approval token bound to `tool`. Returns the token string.
pub fn mint(tool: &str) -> String {
    let token = random_token();
    let mut store = STORE.lock();
    gc(&mut store);
    store.insert(
        token.clone(),
        TokenEntry {
            tool: tool.to_string(),
            minted: Instant::now(),
        },
    );
    token
}

/// Validate `token` for `tool` and remove it (single-use). Returns `true` only
/// if the token exists, is not expired, and was minted for this exact tool.
pub fn consume(tool: &str, token: &str) -> bool {
    let mut store = STORE.lock();
    gc(&mut store);
    match store.remove(token) {
        Some(entry) => {
            entry.tool == tool && Instant::now().duration_since(entry.minted) < TOKEN_TTL
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_then_consume_succeeds_once() {
        let t = mint("agent_run_shell");
        assert!(consume("agent_run_shell", &t), "first consume must succeed");
        // Single-use: the same token cannot be consumed twice.
        assert!(!consume("agent_run_shell", &t), "second consume must fail");
    }

    #[test]
    fn consume_rejects_wrong_tool() {
        let t = mint("agent_write_file");
        // Token is bound to its tool — a different tool name must be rejected.
        assert!(!consume("agent_run_shell", &t));
        // And the token is now consumed even on the mismatched attempt, so a
        // subsequent correct-tool consume also fails (fail-closed).
        assert!(!consume("agent_write_file", &t));
    }

    #[test]
    fn consume_rejects_unknown_token() {
        assert!(!consume("agent_run_shell", "deadbeef"));
        assert!(!consume("agent_run_shell", ""));
    }

    #[test]
    fn expired_token_is_rejected() {
        let token = random_token();
        {
            let mut store = STORE.lock();
            // Inject a token minted well outside the TTL window.
            store.insert(
                token.clone(),
                TokenEntry {
                    tool: "agent_http_request".into(),
                    minted: Instant::now() - TOKEN_TTL - Duration::from_secs(1),
                },
            );
        }
        assert!(!consume("agent_http_request", &token), "expired token must fail");
    }

    #[test]
    fn distinct_mints_yield_distinct_tokens() {
        let a = mint("agent_applescript_run");
        let b = mint("agent_applescript_run");
        assert_ne!(a, b, "tokens must be unique");
        assert!(consume("agent_applescript_run", &a));
        assert!(consume("agent_applescript_run", &b));
    }
}
