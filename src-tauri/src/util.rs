//! Small shared helpers used across multiple backend modules. Kept here so
//! byte-identical logic isn't copy-pasted between modules.

use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Max length for a user-supplied path before `expand_home` rejects it.
pub const MAX_PATH_LEN: usize = 4096;

/// Expand a leading `~` / `~/` to the user's home directory and reject
/// obviously invalid input (empty, oversized, embedded null).
pub fn expand_home(p: &str) -> Result<PathBuf> {
    if p.is_empty() || p.len() > MAX_PATH_LEN {
        return Err(anyhow!("path length invalid"));
    }
    if p.contains('\0') {
        return Err(anyhow!("path contains null byte"));
    }
    if let Some(rest) = p.strip_prefix("~/") {
        Ok(dirs::home_dir()
            .ok_or_else(|| anyhow!("home dir unavailable"))?
            .join(rest))
    } else if p == "~" {
        dirs::home_dir().ok_or_else(|| anyhow!("home dir unavailable"))
    } else {
        Ok(PathBuf::from(p))
    }
}

/// Serialize an `f32` slice to a little-endian byte blob (4 bytes/element).
/// Inverse of [`blob_to_vec`].
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Decode a little-endian byte blob back into an `f32` vector. Inverse of
/// [`vec_to_blob`]; trailing bytes that don't form a full f32 are dropped.
pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Cheap, non-cryptographic xorshift PRNG word. Used only to avoid id
/// collisions on same-nanosecond calls. The thread-local seed is supplied by
/// the caller so callers keep independent streams.
pub fn xorshift(state: &std::cell::Cell<u32>) -> u32 {
    let mut x = state.get();
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    state.set(x);
    x
}

/// Current time in nanoseconds since the Unix epoch (0 on clock error).
pub fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_home_rejects_invalid() {
        assert!(expand_home("").is_err());
        assert!(expand_home("with\0null").is_err());
        let big = "a".repeat(MAX_PATH_LEN + 1);
        assert!(expand_home(&big).is_err());
    }

    #[test]
    fn blob_roundtrips() {
        let v = vec![1.0_f32, -2.5, 3.125, 0.0];
        assert_eq!(blob_to_vec(&vec_to_blob(&v)), v);
    }
}
