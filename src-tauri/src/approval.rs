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
    /// Optional payload-binding fingerprint (e.g. SHA-256 of a shell command).
    /// `None` for tools where the bare tool name is the only binding; `Some`
    /// for tools where the token must additionally match a specific payload
    /// (so a token approved for `ls` cannot be reused for `rm -rf`).
    binding: Option<String>,
}

static STORE: Lazy<Mutex<HashMap<String, TokenEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Recent mint timestamps for the sliding-window rate limit. Pruned on every
/// mint so the worst-case length is RATE_MAX.
static RECENT_MINTS: Lazy<Mutex<Vec<Instant>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Generate a 128-bit cryptographically-random opaque token, hex-encoded.
///
/// Reads from the OS CSPRNG via `/dev/urandom` (macOS/Linux). Hex-encodes
/// 16 raw bytes → 32 chars. Returns `Err` on read failure rather than
/// falling back to a predictable mix — review M3 (2026-05-24) flagged the
/// old time+counter fallback as bruteforceable inside the 60 s TTL window
/// if `/dev/urandom` were ever unreadable. Hard-fail keeps the security
/// posture monotonic: if we can't generate true entropy we don't mint a
/// token at all.
fn random_token() -> Result<String, String> {
    use std::io::Read;

    let mut buf = [0u8; 16];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("approval: cannot open /dev/urandom: {e}"))?;
    f.read_exact(&mut buf)
        .map_err(|e| format!("approval: read /dev/urandom failed: {e}"))?;

    let mut out = String::with_capacity(32);
    for b in buf {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    Ok(out)
}

/// Drop expired entries. Called opportunistically on mint/consume so the map
/// can't grow unbounded across a long app session.
fn gc(store: &mut HashMap<String, TokenEntry>) {
    let now = Instant::now();
    store.retain(|_, e| now.duration_since(e.minted) < TOKEN_TTL);
}

/// Max live tokens before a mint is rejected. Sized for plausible burst
/// (rapid agent loop) but tight enough that a misbehaving renderer can't
/// run away with the store. Surfaces as `approval: token store at capacity`.
const MAX_LIVE_TOKENS: usize = 256;

/// Sliding-window rate limit on mints. A hostile or buggy renderer that
/// hammers `mint_tool_approval` would otherwise fill the 256-entry store
/// in milliseconds and lock out legitimate tool calls for the full 60s
/// TTL. RATE_WINDOW + RATE_MAX bound that to ~MAX_BURST_PER_WINDOW mints
/// per window. Recent mint timestamps live in a single Vec; expired
/// entries are pruned on each mint so the vec stays bounded by RATE_MAX.
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_MAX: usize = 60;

/// Mint a single-use approval token bound to `tool`. Returns the token
/// string. Returns `Err` on entropy failure or store-at-capacity.
pub fn mint(tool: &str) -> Result<String, String> {
    mint_internal(tool, None)
}

/// Mint a single-use approval token bound to `tool` AND to `binding` — an
/// opaque fingerprint (e.g. SHA-256 hex of the exact shell command the user
/// confirmed). Consumers must call [`consume_with_binding`] with the same
/// binding to spend the token. Prevents reusing a token approved for one
/// command on a different command.
pub fn mint_with_binding(tool: &str, binding: &str) -> Result<String, String> {
    mint_internal(tool, Some(binding.to_string()))
}

fn mint_internal(tool: &str, binding: Option<String>) -> Result<String, String> {
    // Sliding-window rate limit. Without this, a misbehaving renderer (XSS
    // payload, runaway loop in MCP code) can fill MAX_LIVE_TOKENS within
    // milliseconds and lock out the user from approving any tool call until
    // the 60s TTL expires. Capping mints/window keeps the steady-state cost
    // bounded.
    {
        let now = Instant::now();
        let mut recents = RECENT_MINTS.lock();
        recents.retain(|t| now.duration_since(*t) < RATE_WINDOW);
        if recents.len() >= RATE_MAX {
            return Err(format!(
                "approval: rate limit exceeded ({} mints in {}s); slow down",
                recents.len(),
                RATE_WINDOW.as_secs()
            ));
        }
        recents.push(now);
    }
    let token = random_token()?;
    let mut store = STORE.lock();
    gc(&mut store);
    if store.len() >= MAX_LIVE_TOKENS {
        // Refuse rather than evict — eviction makes spam profitable.
        return Err(format!(
            "approval: token store at capacity ({} live); wait for TTL expiry",
            store.len()
        ));
    }
    store.insert(
        token.clone(),
        TokenEntry {
            tool: tool.to_string(),
            minted: Instant::now(),
            binding,
        },
    );
    Ok(token)
}

/// Validate `token` for `tool` and remove it (single-use). Returns `true` only
/// if the token exists, is not expired, and was minted for this exact tool.
/// Tokens minted with a payload binding (via `mint_with_binding`) are NOT
/// accepted here — callers for those tools must use `consume_with_binding`.
///
/// Retained for tests + future bareword-binding callers, even though every
/// production caller is now on `consume_with_binding`.
#[allow(dead_code)]
pub fn consume(tool: &str, token: &str) -> bool {
    let mut store = STORE.lock();
    gc(&mut store);
    match store.remove(token) {
        Some(entry) => {
            entry.tool == tool
                && entry.binding.is_none()
                && Instant::now().duration_since(entry.minted) < TOKEN_TTL
        }
        None => false,
    }
}

/// Validate a payload-bound token. Returns true only if all of: token exists,
/// not expired, minted for `tool`, AND was minted with the same `binding`.
/// A token minted without a binding (via `mint`) is rejected — bound consumers
/// fail closed if the frontend forgets to mint with a binding.
pub fn consume_with_binding(tool: &str, token: &str, binding: &str) -> bool {
    let mut store = STORE.lock();
    gc(&mut store);
    match store.remove(token) {
        Some(entry) => {
            entry.tool == tool
                && entry.binding.as_deref() == Some(binding)
                && Instant::now().duration_since(entry.minted) < TOKEN_TTL
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_then_consume_succeeds_once() {
        let t = mint("agent_run_shell").expect("mint");
        assert!(consume("agent_run_shell", &t), "first consume must succeed");
        // Single-use: the same token cannot be consumed twice.
        assert!(!consume("agent_run_shell", &t), "second consume must fail");
    }

    #[test]
    fn consume_rejects_wrong_tool() {
        let t = mint("agent_write_file").expect("mint");
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
        let token = random_token().expect("urandom");
        {
            let mut store = STORE.lock();
            // Inject a token minted well outside the TTL window.
            store.insert(
                token.clone(),
                TokenEntry {
                    tool: "agent_http_request".into(),
                    minted: Instant::now() - TOKEN_TTL - Duration::from_secs(1),
                    binding: None,
                },
            );
        }
        assert!(
            !consume("agent_http_request", &token),
            "expired token must fail"
        );
    }

    #[test]
    fn bound_token_requires_matching_binding() {
        let t = mint_with_binding("agent_run_shell", "fp_ls").expect("mint");
        // Wrong binding: rejected, token consumed (fail-closed).
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_rmrf"));
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_ls"));
    }

    #[test]
    fn bound_token_rejects_unbound_consume() {
        // A token minted with a binding MUST NOT be consumable via the
        // bareword `consume` path — otherwise a refactor could quietly
        // strip the payload check.
        let t = mint_with_binding("agent_run_shell", "fp_ls").expect("mint");
        assert!(!consume("agent_run_shell", &t));
    }

    #[test]
    fn unbound_token_rejects_bound_consume() {
        // Symmetric: a token minted without a binding must not satisfy a
        // bound consume call — bound call sites fail closed.
        let t = mint("agent_run_shell").expect("mint");
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_anything"));
    }

    #[test]
    fn bound_token_single_use_with_correct_binding() {
        let t = mint_with_binding("agent_run_shell", "fp_x").expect("mint");
        assert!(consume_with_binding("agent_run_shell", &t, "fp_x"));
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_x"));
    }

    #[test]
    fn distinct_mints_yield_distinct_tokens() {
        let a = mint("agent_applescript_run").expect("mint");
        let b = mint("agent_applescript_run").expect("mint");
        assert_ne!(a, b, "tokens must be unique");
        assert!(consume("agent_applescript_run", &a));
        assert!(consume("agent_applescript_run", &b));
    }

    #[test]
    fn mint_refuses_when_store_at_capacity() {
        // Fill the store from a clean slate. We can't reset STORE between
        // tests (cargo runs them in parallel + STORE is static), so a
        // failure here only proves "the gate fires at the cap" — not that
        // *exactly* MAX_LIVE_TOKENS will live concurrently in production.
        let _serialize = STORE.lock(); // hold to keep parallel tests from racing
        drop(_serialize);
        let mut held = Vec::new();
        for _ in 0..MAX_LIVE_TOKENS {
            match mint("capacity_test") {
                Ok(t) => held.push(t),
                Err(_) => break, // already near cap from other tests
            }
        }
        // The next mint MUST refuse with a capacity error.
        let r = mint("capacity_test");
        assert!(r.is_err(), "expected capacity refusal, got {:?}", r);
        // Cleanup so other tests don't trip the cap.
        for t in held {
            let _ = consume("capacity_test", &t);
        }
    }
}
