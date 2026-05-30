//! Shared per-op cancellation tokens for streaming chat backends.
//!
//! The native (mistralrs) chat stream and the custom/OpenRouter SSE stream
//! both run a long `recv`/`next` loop that, without cancellation, keeps
//! generating (native: to `max_tokens`) or keeps draining the HTTP body
//! (custom: to the 180s timeout) after the user hits Stop or navigates away —
//! wasted GPU / bandwidth. This registry, keyed by the frontend-minted
//! `op_id`, lets the `*_cancel(op_id)` IPC fire a token the stream loop is
//! racing via `tokio::select!`. Mirrors the image engine's per-op token map.
//! (2026-05-30)

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

fn registry() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static REG: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mint (or reuse) the cancellation token for `op_id`. Idempotent: a cancel
/// that landed between IPC dispatch and stream start reuses the same token, so
/// the user's Stop is never lost to a fresh-token overwrite.
pub fn register(op_id: &str) -> CancellationToken {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = map.get(op_id) {
        return t.clone();
    }
    let t = CancellationToken::new();
    map.insert(op_id.to_string(), t.clone());
    t
}

/// Remove the entry for `op_id` on terminal success/error so the map can't
/// leak. Safe to call for an unknown id.
pub fn release(op_id: &str) {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(op_id);
}

/// Fire the token for `op_id` if one is registered. Returns `true` when an op
/// was actually pending, `false` when the id was unknown (already finished or
/// never started).
pub fn cancel(op_id: &str) -> bool {
    match registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(op_id)
        .cloned()
    {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    }
}
