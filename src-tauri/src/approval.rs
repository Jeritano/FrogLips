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

/// Generate a 128-bit cryptographically-random opaque token, hex-encoded.
///
/// Reads from the OS CSPRNG via `/dev/urandom` (macOS/Linux). This replaces
/// the previous time+counter mix, which was predictable enough that an
/// attacker who could observe (or guess) the clock could feasibly forge a
/// token within the 60s TTL window. We hex-encode 16 raw bytes → 32 chars.
///
/// On the (effectively impossible) failure to read /dev/urandom we fall back
/// to a time+counter+pid mix XOR'd into the buffer rather than returning a
/// predictable value — so the worst case still has some entropy, but
/// successful reads (the only path you'll ever see in practice on macOS)
/// give a full 128 bits.
fn random_token() -> String {
    use std::io::Read;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let mut buf = [0u8; 16];
    let mut filled = false;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            filled = true;
        }
    }
    if !filled {
        // Fallback path — should not happen on macOS. Mix several entropy
        // sources into the buffer so the token is at least not trivially
        // predictable from the clock alone.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id() as u128;
        let mix = nanos
            ^ ((n as u128) << 64)
            ^ (n as u128).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ pid.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        buf.copy_from_slice(&mix.to_le_bytes());
    }

    let mut out = String::with_capacity(32);
    for b in buf {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Drop expired entries. Called opportunistically on mint/consume so the map
/// can't grow unbounded across a long app session.
fn gc(store: &mut HashMap<String, TokenEntry>) {
    let now = Instant::now();
    store.retain(|_, e| now.duration_since(e.minted) < TOKEN_TTL);
}

/// Mint a single-use approval token bound to `tool`. Returns the token string.
pub fn mint(tool: &str) -> String {
    mint_internal(tool, None)
}

/// Mint a single-use approval token bound to `tool` AND to `binding` — an
/// opaque fingerprint (e.g. SHA-256 hex of the exact shell command the user
/// confirmed). Consumers must call [`consume_with_binding`] with the same
/// binding to spend the token. Prevents reusing a token approved for one
/// command on a different command.
pub fn mint_with_binding(tool: &str, binding: &str) -> String {
    mint_internal(tool, Some(binding.to_string()))
}

fn mint_internal(tool: &str, binding: Option<String>) -> String {
    let token = random_token();
    let mut store = STORE.lock();
    gc(&mut store);
    store.insert(
        token.clone(),
        TokenEntry {
            tool: tool.to_string(),
            minted: Instant::now(),
            binding,
        },
    );
    token
}

/// Validate `token` for `tool` and remove it (single-use). Returns `true` only
/// if the token exists, is not expired, and was minted for this exact tool.
/// Tokens minted with a payload binding (via `mint_with_binding`) are NOT
/// accepted here — callers for those tools must use `consume_with_binding`.
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
        let t = mint_with_binding("agent_run_shell", "fp_ls");
        // Wrong binding: rejected, token consumed (fail-closed).
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_rmrf"));
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_ls"));
    }

    #[test]
    fn bound_token_rejects_unbound_consume() {
        // A token minted with a binding MUST NOT be consumable via the
        // bareword `consume` path — otherwise a refactor could quietly
        // strip the payload check.
        let t = mint_with_binding("agent_run_shell", "fp_ls");
        assert!(!consume("agent_run_shell", &t));
    }

    #[test]
    fn unbound_token_rejects_bound_consume() {
        // Symmetric: a token minted without a binding must not satisfy a
        // bound consume call — bound call sites fail closed.
        let t = mint("agent_run_shell");
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_anything"));
    }

    #[test]
    fn bound_token_single_use_with_correct_binding() {
        let t = mint_with_binding("agent_run_shell", "fp_x");
        assert!(consume_with_binding("agent_run_shell", &t, "fp_x"));
        assert!(!consume_with_binding("agent_run_shell", &t, "fp_x"));
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
