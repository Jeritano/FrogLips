//! Tracks in-flight HuggingFace model downloads so two downloaders never race
//! the same repo's `.incomplete` blobs.
//!
//! The bug this guards (2026-06-22): `pull_hf_model` (the Model Library "Pull")
//! spawns `hf download`, while `start_server` auto-start-on-select spawns
//! `mlx_lm.server`, which ALSO downloads from HuggingFace when the snapshot
//! isn't fully cached. Run concurrently against the same repo, the two writers
//! reset each other's partial blobs — observed ~9.9 GB of progress collapse
//! back to ~1 GB, then stall, forcing a manual clean re-pull.
//!
//! `begin()` is a single-flight gate: it records the repo as downloading and
//! returns an RAII guard that clears it on drop (download finished, errored, or
//! was cancelled via `kill_on_drop`). `is_active()` lets the server-start path
//! refuse to launch a second downloader while a pull is in flight.

use std::collections::HashSet;
use std::sync::Mutex;

use once_cell::sync::Lazy;

static ACTIVE: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// RAII marker returned by [`begin`]; removes the repo from the active set when
/// dropped. Held for the lifetime of a download (including across `.await`).
#[must_use = "drop the guard only when the download is finished"]
pub struct DownloadGuard(String);

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = ACTIVE.lock() {
            set.remove(&self.0);
        }
    }
}

/// Mark `repo_id` as downloading. Returns `None` if a download for that repo is
/// already in flight — the caller MUST refuse rather than start a second
/// downloader that would corrupt the in-flight one.
pub fn begin(repo_id: &str) -> Option<DownloadGuard> {
    let mut set = ACTIVE.lock().ok()?;
    if !set.insert(repo_id.to_string()) {
        return None; // already downloading
    }
    Some(DownloadGuard(repo_id.to_string()))
}

/// True if a HuggingFace download is currently in flight for `repo_id`.
pub fn is_active(repo_id: &str) -> bool {
    ACTIVE.lock().map(|s| s.contains(repo_id)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_flights_and_releases_on_drop() {
        // Unique repo id so this test can't collide with parallel tests that
        // share the process-global ACTIVE set.
        let repo = "test-only/download-registry-fixture-7B-4bit";
        assert!(!is_active(repo));

        let g = begin(repo).expect("first begin succeeds");
        assert!(is_active(repo));
        // A second concurrent begin is refused while the first guard lives.
        assert!(begin(repo).is_none());

        drop(g);
        // Dropping the guard clears the entry → a fresh download may start.
        assert!(!is_active(repo));
        assert!(begin(repo).is_some());
    }
}
