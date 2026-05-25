//! In-memory undo stack for agent file edits. Whenever `write_file`,
//! `edit_file`, or `multi_edit` is about to modify a file inside the
//! workspace, the prior contents are pushed onto a bounded LIFO. The
//! `agent_undo` IPC pops the most recent entry and writes the bytes back
//! to disk.
//!
//! This is **not** a general version-control system. It's a per-session
//! safety net: caps the stack at `MAX_ENTRIES`, drops on app restart, and
//! holds entries as raw `Vec<u8>` so the model can experiment without
//! losing a working file to a bad edit.
//!
//! Pre-existing files only — `write_file` against a brand-new path pushes
//! an `Absent` marker so undo restores the "file didn't exist" state by
//! deleting it.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 50;
const MAX_PER_ENTRY_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

#[derive(Clone)]
enum PriorState {
    Bytes(Vec<u8>),
    Absent,
}

#[derive(Clone)]
struct Entry {
    path: PathBuf,
    prior: PriorState,
    /// Wall-clock ms since epoch when the snapshot was taken. Surfaced to
    /// the user so the undo confirmation can show "from N seconds ago".
    taken_at_ms: u64,
    /// Free-form label describing what produced the snapshot
    /// (`write_file` / `edit_file` / `multi_edit`).
    kind: &'static str,
}

static STACK: Lazy<Mutex<VecDeque<Entry>>> = Lazy::new(|| Mutex::new(VecDeque::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Snapshot using bytes the caller already has in memory — avoids a
/// second read for callers (like `edit_file`) that just loaded the file.
pub fn capture_with_bytes(path: &Path, prior_bytes: Vec<u8>, kind: &'static str) {
    if prior_bytes.len() > MAX_PER_ENTRY_BYTES {
        return;
    }
    let mut s = STACK.lock();
    s.push_back(Entry {
        path: path.to_path_buf(),
        prior: PriorState::Bytes(prior_bytes),
        taken_at_ms: now_ms(),
        kind,
    });
    while s.len() > MAX_ENTRIES {
        s.pop_front();
    }
}

/// Snapshot the current contents of `path` (or mark it absent) before a
/// mutating operation. Silently no-ops if the file is larger than the
/// per-entry cap so we never block a legitimate large write — the user
/// just loses undo coverage for that one file.
pub fn capture(path: &Path, kind: &'static str) {
    let prior = match std::fs::metadata(path) {
        Ok(md) if md.is_file() => {
            if md.len() as usize > MAX_PER_ENTRY_BYTES {
                return;
            }
            match std::fs::read(path) {
                Ok(b) => PriorState::Bytes(b),
                Err(_) => return,
            }
        }
        Ok(_) => return, // directory — not a write_file target
        Err(_) => PriorState::Absent,
    };
    let mut s = STACK.lock();
    s.push_back(Entry {
        path: path.to_path_buf(),
        prior,
        taken_at_ms: now_ms(),
        kind,
    });
    while s.len() > MAX_ENTRIES {
        s.pop_front();
    }
}

#[derive(Serialize)]
pub struct UndoEntry {
    pub path: String,
    pub kind: &'static str,
    pub taken_at_ms: u64,
    pub size_bytes: usize,
    pub was_absent: bool,
}

/// List the current undo stack newest-first so the model (or a future UI)
/// can show what `agent_undo` would revert next.
pub fn list_undo() -> Vec<UndoEntry> {
    let s = STACK.lock();
    s.iter()
        .rev()
        .map(|e| UndoEntry {
            path: e.path.to_string_lossy().into_owned(),
            kind: e.kind,
            taken_at_ms: e.taken_at_ms,
            size_bytes: match &e.prior {
                PriorState::Bytes(b) => b.len(),
                PriorState::Absent => 0,
            },
            was_absent: matches!(e.prior, PriorState::Absent),
        })
        .collect()
}

#[derive(Serialize)]
pub struct UndoResult {
    pub path: String,
    pub kind: &'static str,
    pub restored_bytes: usize,
    pub was_absent: bool,
}

/// Pop the most recent snapshot and restore the file (or delete it if the
/// snapshot recorded the file as absent). Returns the entry that was
/// restored so the caller can surface "Reverted X" to the user.
pub fn undo_last() -> Result<UndoResult, String> {
    let Some(entry) = STACK.lock().pop_back() else {
        return Err("nothing to undo".into());
    };
    let path = entry.path.clone();
    match entry.prior {
        PriorState::Bytes(bytes) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // SECURITY: `std::fs::write` follows symlinks at the leaf. Between
            // the agent-tool call that captured this snapshot and the user
            // clicking Undo, an attacker could race-swap the target with a
            // symlink to e.g. `/etc/hosts` or `~/.ssh/authorized_keys` and
            // the restore would happily write the captured bytes there.
            // Reuse the existing `write_nofollow_sync` helper (the same
            // primitive `write_file` / `edit_file` already use) so the
            // kernel refuses to open a symlink at the final path component.
            crate::agent::fs::write_nofollow_sync(&path, &bytes, false)
                .map_err(|e| format!("restore write failed: {e}"))?;
            Ok(UndoResult {
                path: path.to_string_lossy().into_owned(),
                kind: entry.kind,
                restored_bytes: bytes.len(),
                was_absent: false,
            })
        }
        PriorState::Absent => {
            // File didn't exist before the captured edit — undoing the
            // create means deleting it. Ignore not-found in case the user
            // already removed it manually.
            match std::fs::remove_file(&path) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("restore delete failed: {e}")),
            }
            Ok(UndoResult {
                path: path.to_string_lossy().into_owned(),
                kind: entry.kind,
                restored_bytes: 0,
                was_absent: true,
            })
        }
    }
}

/// Empty the stack — used by the IPC layer when the workspace root
/// changes so a stale snapshot can't be re-applied against a different
/// project.
pub fn clear() {
    STACK.lock().clear();
}

#[cfg(test)]
mod tests {
    //! These tests mutate the global STACK so we serialize them through a
    //! per-test mutex. Cargo runs tests in parallel by default and the global
    //! state makes them race otherwise.
    use super::*;
    use parking_lot::Mutex as PLMutex;
    use std::io::Write;

    static TEST_LOCK: PLMutex<()> = PLMutex::new(());

    #[test]
    fn undo_restores_prior_bytes() {
        let _g = TEST_LOCK.lock();
        clear();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, b"hello").unwrap();
        capture(&p, "test");
        std::fs::write(&p, b"world").unwrap();
        let r = undo_last().unwrap();
        assert_eq!(r.restored_bytes, b"hello".len());
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
    }

    #[test]
    fn undo_deletes_created_file() {
        let _g = TEST_LOCK.lock();
        clear();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("new.txt");
        capture(&p, "test"); // file doesn't exist → records Absent
        std::fs::write(&p, b"created").unwrap();
        let r = undo_last().unwrap();
        assert!(r.was_absent);
        assert!(!p.exists());
    }

    #[test]
    fn stack_caps_at_max_entries() {
        let _g = TEST_LOCK.lock();
        clear();
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_ENTRIES + 10) {
            let p = dir.path().join(format!("f{i}.txt"));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"x").unwrap();
            capture(&p, "test");
        }
        assert_eq!(list_undo().len(), MAX_ENTRIES);
    }

    #[test]
    fn undo_empty_errors() {
        let _g = TEST_LOCK.lock();
        clear();
        let r = undo_last();
        assert!(r.is_err());
    }
}
