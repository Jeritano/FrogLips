//! Filesystem watcher tool for the agent loop.
//!
//! Cross-platform (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW
//! on Windows) via the `notify` crate. The agent calls `watch_path` to start a
//! watcher and gets a `watch_id`; subsequent `poll_watch` calls drain the
//! accumulated events. Events are buffered in a bounded ring (4096 max per
//! watch) and any overflow is counted in a `dropped` field so the agent can
//! detect lost events instead of getting a silently-truncated stream.
//!
//! Auto-GC: a background thread stops any watcher that has gone 30 minutes
//! without a `poll_watch` call. Cleanup on app exit happens via
//! `shutdown_all`, called from `RunEvent::Exit` like the MCP shutdown.
//!
//! These tools are read-only — no filesystem mutation — so they should not
//! trigger the agent's approval modal.

use anyhow::{anyhow, Result};
use globset::{Glob, GlobMatcher};
use notify::event::{ModifyKind, RenameMode};
use notify::{
    Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Max events buffered per watch before old ones get dropped to make room.
const RING_CAPACITY: usize = 4096;
/// Default cap for events returned in a single `poll_watch` call.
const DEFAULT_MAX_EVENTS: u32 = 100;
/// Auto-stop a watcher after this many milliseconds without a `poll_watch`.
const INACTIVITY_TIMEOUT_MS: u64 = 30 * 60 * 1000;
/// How often the GC thread checks for idle watchers.
const GC_INTERVAL: Duration = Duration::from_secs(60);

/* ── Public types ───────────────────────────────────────────────────────── */

#[derive(Serialize, Clone, Debug)]
pub struct WatchHandle {
    pub watch_id: String,
    pub path: String,
    pub glob: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct WatchInfo {
    pub watch_id: String,
    pub path: String,
    pub glob: Option<String>,
    pub started_at: u64,
    pub events_seen: u64,
    pub buffered: u32,
    pub dropped: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct WatchEvent {
    /// "created" | "modified" | "deleted" | "renamed" | "other"
    pub kind: String,
    pub path: String,
    /// Unix epoch milliseconds.
    pub ts: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct WatchPoll {
    pub events: Vec<WatchEvent>,
    /// Pass this as `since_ms` on the next call to continue from where you left off.
    pub next_ts: u64,
    /// Events elided by the per-call `max_events` cap (events that matched but
    /// did not fit). Ring-buffer overflow drops are reported via `WatchInfo`.
    pub dropped: u32,
}

/* ── Internal state ─────────────────────────────────────────────────────── */

struct WatchEntry {
    info: WatchInfo,
    /// Bounded ring of buffered events (oldest first).
    ring: VecDeque<WatchEvent>,
    /// Optional glob filter applied to event paths (the live one is held by the
    /// callback closure; this copy is kept on the entry for future poll-time
    /// re-filtering and diagnostics).
    #[allow(dead_code)]
    glob: Option<GlobMatcher>,
    /// Last poll time (unix ms) — drives the inactivity GC.
    last_poll_ms: u64,
    /// Held to keep the OS watcher alive; dropped on stop.
    _watcher: RecommendedWatcher,
}

static REGISTRY: Lazy<Mutex<HashMap<String, Arc<Mutex<WatchEntry>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

static GC_STARTED: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // thread-local xorshift, like task_queue::rand_seed
    use std::cell::Cell;
    thread_local!(static SEED: Cell<u32> = const { Cell::new(0xa5a5_5a5a) });
    let r = SEED.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s.set(x);
        x
    });
    format!("w_{:x}{:x}", nanos as u64, r)
}

fn expand_home(p: &str) -> Result<PathBuf> {
    if p.is_empty() || p.len() > 4096 {
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

fn classify(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "deleted",
        EventKind::Modify(ModifyKind::Name(RenameMode::From))
        | EventKind::Modify(ModifyKind::Name(RenameMode::To))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Other)) => "renamed",
        EventKind::Modify(_) => "modified",
        _ => "other",
    }
}

/// Push an event into the ring, evicting the oldest if full.
fn push_event(entry: &mut WatchEntry, ev: WatchEvent) {
    if entry.ring.len() >= RING_CAPACITY {
        entry.ring.pop_front();
        entry.info.dropped = entry.info.dropped.saturating_add(1);
    }
    entry.ring.push_back(ev);
    entry.info.events_seen = entry.info.events_seen.saturating_add(1);
    entry.info.buffered = entry.ring.len() as u32;
}

fn ensure_gc_running() {
    let mut started = GC_STARTED.lock();
    if *started {
        return;
    }
    *started = true;
    drop(started);
    std::thread::spawn(|| loop {
        std::thread::sleep(GC_INTERVAL);
        let now = now_ms();
        let stale: Vec<String> = {
            let g = REGISTRY.lock();
            g.iter()
                .filter_map(|(id, e)| {
                    let last = e.lock().last_poll_ms;
                    if now.saturating_sub(last) >= INACTIVITY_TIMEOUT_MS {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };
        for id in stale {
            let _ = stop_watch(id);
        }
    });
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/// Start watching a path. `glob` (if given) filters event paths against a
/// shell-style glob. `debounce_ms` collapses bursts of events on the same
/// path within the window (most useful for editor-save patterns that emit
/// rename+create+modify within a few ms).
pub async fn watch_path(
    path: String,
    glob: Option<String>,
    debounce_ms: Option<u64>,
) -> Result<WatchHandle, String> {
    ensure_gc_running();

    let resolved = expand_home(&path).map_err(|e| e.to_string())?;
    if !resolved.exists() {
        return Err(format!("path does not exist: {}", resolved.display()));
    }
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let recursive = canonical.is_dir();

    let matcher: Option<GlobMatcher> = match glob.as_deref() {
        Some(g) if !g.is_empty() => Some(
            Glob::new(g)
                .map_err(|e| format!("invalid glob: {e}"))?
                .compile_matcher(),
        ),
        _ => None,
    };
    let debounce = Duration::from_millis(debounce_ms.unwrap_or(0));

    let id = random_id();
    let id_for_cb = id.clone();
    let matcher_for_cb = matcher.clone();
    let root_for_cb = canonical.clone();

    // Per-watch debounce map: path -> (last_ts_ms, last_kind).
    let last_seen: Arc<Mutex<HashMap<String, (u64, String)>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let last_seen_for_cb = last_seen.clone();

    let cb_handler = move |res: notify::Result<NotifyEvent>| {
        let Ok(event) = res else { return };
        let kind = classify(&event.kind).to_string();
        if kind == "other" {
            return;
        }
        let ts = now_ms();
        for p in event.paths.iter() {
            // Defense-in-depth: FSEvents on macOS can over-report events from
            // sibling directories on the same volume in pathological cases.
            // Require the event path to actually be under the watched root.
            if !p.starts_with(&root_for_cb) {
                continue;
            }
            let p_str = p.to_string_lossy().into_owned();
            if let Some(m) = &matcher_for_cb {
                if !m.is_match(p) {
                    continue;
                }
            }
            // Debounce: skip same-path same-kind events inside the window.
            if !debounce.is_zero() {
                let mut g = last_seen_for_cb.lock();
                if let Some((prev_ts, prev_kind)) = g.get(&p_str) {
                    if *prev_kind == kind && ts.saturating_sub(*prev_ts) < debounce.as_millis() as u64 {
                        continue;
                    }
                }
                g.insert(p_str.clone(), (ts, kind.clone()));
            }
            let ev = WatchEvent { kind: kind.clone(), path: p_str, ts };
            let entry_opt = REGISTRY.lock().get(&id_for_cb).cloned();
            if let Some(entry) = entry_opt {
                push_event(&mut entry.lock(), ev);
            }
        }
    };

    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(cb_handler).map_err(|e| format!("watcher init: {e}"))?;
    let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
    watcher
        .watch(&canonical, mode)
        .map_err(|e| format!("watch failed: {e}"))?;

    let info = WatchInfo {
        watch_id: id.clone(),
        path: canonical.to_string_lossy().into_owned(),
        glob: glob.clone(),
        started_at: now_ms(),
        events_seen: 0,
        buffered: 0,
        dropped: 0,
    };
    let entry = WatchEntry {
        info: info.clone(),
        ring: VecDeque::with_capacity(64),
        glob: matcher,
        last_poll_ms: now_ms(),
        _watcher: watcher,
    };
    REGISTRY.lock().insert(id.clone(), Arc::new(Mutex::new(entry)));

    Ok(WatchHandle {
        watch_id: id,
        path: info.path,
        glob,
    })
}

pub fn list_watches() -> Vec<WatchInfo> {
    REGISTRY
        .lock()
        .values()
        .map(|e| e.lock().info.clone())
        .collect()
}

pub async fn poll_watch(
    id: String,
    since_ms: Option<u64>,
    max_events: Option<u32>,
) -> Result<WatchPoll, String> {
    let entry = REGISTRY
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no watch {id}"))?;
    let cap = max_events.unwrap_or(DEFAULT_MAX_EVENTS).max(1) as usize;
    let cutoff = since_ms.unwrap_or(0);

    let mut g = entry.lock();
    g.last_poll_ms = now_ms();

    // Drain events newer than cutoff; events older than cutoff are discarded
    // (the caller has implicitly acknowledged them by advancing `since_ms`).
    let mut matched: Vec<WatchEvent> = Vec::new();
    for ev in g.ring.drain(..) {
        if ev.ts > cutoff {
            matched.push(ev);
        }
    }
    // matched is in time order (ring is FIFO). Take up to `cap`; the rest stay buffered.
    let dropped: u32;
    let events: Vec<WatchEvent>;
    if matched.len() > cap {
        let tail = matched.split_off(cap);
        dropped = tail.len() as u32;
        // Put the overflow back into the ring (preserve order at the front).
        for ev in tail.into_iter().rev() {
            g.ring.push_front(ev);
        }
        events = matched;
    } else {
        dropped = 0;
        events = matched;
    }
    g.info.buffered = g.ring.len() as u32;

    let next_ts = events.last().map(|e| e.ts).unwrap_or(cutoff.max(now_ms()));
    Ok(WatchPoll {
        events,
        next_ts,
        dropped,
    })
}

pub fn stop_watch(id: String) -> Result<(), String> {
    let entry = REGISTRY.lock().remove(&id);
    if entry.is_none() {
        return Err(format!("no watch {id}"));
    }
    // Drop the entry — the RecommendedWatcher inside drops with it, releasing
    // the OS-level watch.
    Ok(())
}

/// Stop every watcher. Called on app exit, mirroring `mcp::shutdown_all`.
pub fn shutdown_all() {
    let drained: Vec<_> = {
        let mut g = REGISTRY.lock();
        g.drain().collect()
    };
    drop(drained); // explicit — drops all watchers
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;
    use tokio::time::sleep;

    /// Helper: small sleep for filesystem events to make it from the kernel
    /// through `notify` and into our ring buffer. macOS FSEvents has ~100ms
    /// minimum coalescing latency, so we give it room.
    async fn flush() {
        sleep(Duration::from_millis(400)).await;
    }

    #[tokio::test]
    async fn watcher_detects_file_create() {
        let tmp = tempdir_in_target("fs_watcher_create");
        let handle = watch_path(tmp.to_string_lossy().into_owned(), None, None)
            .await
            .expect("watch start");

        // Let watcher register before we touch the dir.
        sleep(Duration::from_millis(200)).await;

        let new_file = tmp.join("hello.txt");
        fs::write(&new_file, "hi").expect("write");
        flush().await;

        let poll = poll_watch(handle.watch_id.clone(), None, Some(100))
            .await
            .expect("poll");
        assert!(
            !poll.events.is_empty(),
            "expected at least one event for created file, got 0"
        );
        let any_for_path = poll
            .events
            .iter()
            .any(|e| e.path.ends_with("hello.txt"));
        assert!(any_for_path, "no event mentioned hello.txt: {:?}", poll.events);

        let _ = stop_watch(handle.watch_id);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn debounce_collapses_burst() {
        let tmp = tempdir_in_target("fs_watcher_debounce");
        let handle = watch_path(
            tmp.to_string_lossy().into_owned(),
            None,
            Some(2000), // 2-second debounce window
        )
        .await
        .expect("watch start");

        sleep(Duration::from_millis(200)).await;

        let f = tmp.join("burst.txt");
        fs::write(&f, "a").expect("w1");
        fs::write(&f, "b").expect("w2");
        fs::write(&f, "c").expect("w3");
        fs::write(&f, "d").expect("w4");
        flush().await;

        let poll = poll_watch(handle.watch_id.clone(), None, Some(100))
            .await
            .expect("poll");
        // With a 2s debounce, the 4 rapid writes should collapse to a small number
        // of events (creation may emit its own event separately from modify, so
        // we allow up to 2 — but definitely not 4+).
        let modify_count = poll
            .events
            .iter()
            .filter(|e| e.kind == "modified" && e.path.ends_with("burst.txt"))
            .count();
        assert!(
            modify_count <= 2,
            "expected debounce to cap modify events at ≤2, got {modify_count}: {:?}",
            poll.events
        );

        let _ = stop_watch(handle.watch_id);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ring_buffer_drops_past_capacity() {
        // Synthetic test: bypass notify and push directly into a WatchEntry to
        // verify the dropped counter increments past RING_CAPACITY.
        let tmp = tempdir_in_target("fs_watcher_ring");
        // Build a dummy watcher we'll never actually use — just to satisfy the
        // struct shape.
        let cb = |_res: notify::Result<NotifyEvent>| {};
        let watcher = notify::recommended_watcher(cb).expect("watcher");
        let mut entry = WatchEntry {
            info: WatchInfo {
                watch_id: "test".into(),
                path: tmp.to_string_lossy().into_owned(),
                glob: None,
                started_at: now_ms(),
                events_seen: 0,
                buffered: 0,
                dropped: 0,
            },
            ring: VecDeque::with_capacity(64),
            glob: None,
            last_poll_ms: now_ms(),
            _watcher: watcher,
        };

        for i in 0..(RING_CAPACITY + 50) {
            push_event(
                &mut entry,
                WatchEvent {
                    kind: "modified".into(),
                    path: format!("/tmp/{i}"),
                    ts: i as u64,
                },
            );
        }

        assert_eq!(entry.ring.len(), RING_CAPACITY);
        assert_eq!(entry.info.dropped, 50, "should have dropped 50 oldest");
        assert_eq!(entry.info.events_seen, (RING_CAPACITY + 50) as u64);
        // Oldest survivor should be index 50 (0..49 dropped).
        assert_eq!(entry.ring.front().unwrap().path, "/tmp/50");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Make a unique directory under the system temp dir.
    fn tempdir_in_target(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        p.push(format!("{name}_{nanos}"));
        std::fs::create_dir_all(&p).expect("mkdir");
        std::fs::canonicalize(&p).expect("canonicalize tempdir")
    }
}
