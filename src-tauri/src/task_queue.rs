//! Fire-and-forget background task queue.
//!
//! Each task is a `run_shell` invocation that runs detached from the agent
//! loop. The agent gets a task_id immediately; later calls to task_status /
//! task_result / task_cancel let it (or the user) inspect or cancel.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::agent::{run_shell, ShellOpts, ShellResult};

#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Cancelled,
    Failed,
}

#[derive(Serialize, Clone)]
pub struct TaskInfo {
    pub id: String,
    pub command: String,
    pub status: TaskStatus,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub result: Option<ShellResult>,
    pub error: Option<String>,
}

struct TaskEntry {
    info: TaskInfo,
    cancel: Option<oneshot::Sender<()>>,
}

static TASKS: Lazy<Mutex<HashMap<String, Arc<Mutex<TaskEntry>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const MAX_CONCURRENT_TASKS: usize = 32;

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_id() -> String {
    format!("task-{:x}-{:x}", crate::util::now_nanos(), rand_seed())
}

fn rand_seed() -> u32 {
    // Cheap, not cryptographic — only used to avoid collisions on same-nanosecond
    // calls. L13: the old const 0xdead_beef seed was IDENTICAL on every thread,
    // so two threads' first calls produced the same value at the same nanosecond
    // → colliding task ids → map.insert silently overwrote a live entry. Seed
    // per-thread-unique (mixing nanos) on first use; xorshift then advances it
    // per call so consecutive ids on one thread never repeat.
    use std::cell::Cell;
    thread_local!(static SEED: Cell<u32> = const { Cell::new(0) });
    SEED.with(|s| {
        if s.get() == 0 {
            let init = (crate::util::now_nanos() as u32) ^ 0x9e37_79b9;
            s.set(if init == 0 { 1 } else { init });
        }
        crate::util::xorshift(s)
    })
}

/// Opportunistic auto-prune budget. Code review H2: TASKS never shrank on
/// its own; a long session that fires many background commands leaked
/// `TaskEntry`s forever (the map row stayed even after the task reached a
/// terminal state). Run on every `create` call so the worst case is
/// "next task you start cleans up the previous ones." 30-minute window is
/// long enough that diagnostic introspection (`task_status`/`task_list`)
/// still sees recent runs.
const AUTO_PRUNE_AFTER_SECS: u64 = 30 * 60;

pub fn create(command: String, cwd: Option<String>) -> Result<TaskInfo, String> {
    // Opportunistic auto-prune of long-completed tasks before we count
    // against the cap. Best-effort; no error path matters here.
    let _ = prune(AUTO_PRUNE_AFTER_SECS);
    let id = random_id();
    let info = TaskInfo {
        id: id.clone(),
        command: command.clone(),
        status: TaskStatus::Pending,
        created_at: now_unix(),
        finished_at: None,
        result: None,
        error: None,
    };
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let entry = Arc::new(Mutex::new(TaskEntry {
        info,
        cancel: Some(cancel_tx),
    }));
    let entry_for_task = entry.clone();
    let id_for_task = id.clone();
    let cmd_for_task = command;
    let cwd_for_task = cwd;
    // Crash fix (0.11.0 prod crash report 2BED87A8-FA96-...):
    // `task_create` is registered as a sync `#[tauri::command]` so it runs
    // on the main thread without a tokio runtime context. `tokio::spawn`
    // panics outside a runtime → abort() → SIGABRT crash on the very
    // first agent `task_create` call. Use `tauri::async_runtime::spawn`
    // instead — it's a thin wrapper that grabs Tauri's managed runtime
    // handle and works from both sync and async command contexts.
    // L14: reserve a slot under the TASKS guard BEFORE spawning, so a burst can
    // never momentarily start more than MAX_CONCURRENT_TASKS children (the old
    // order spawned first then rolled back over-cap — a brief real overshoot).
    {
        let mut map = TASKS.lock();
        // Count only non-terminal tasks — terminal entries linger until pruned
        // and must not count against the concurrency cap.
        let active = map
            .values()
            .filter(|e| {
                !matches!(
                    e.lock().info.status,
                    TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
                )
            })
            .count();
        if active >= MAX_CONCURRENT_TASKS {
            return Err(format!(
                "task queue full ({MAX_CONCURRENT_TASKS} active) — cancel finished ones first"
            ));
        }
        map.insert(id.clone(), entry.clone());
    }
    let info = entry.lock().info.clone();
    drop(tauri::async_runtime::spawn(async move {
        // Flip to Running
        entry_for_task.lock().info.status = TaskStatus::Running;

        let opts = ShellOpts {
            cwd: cwd_for_task,
            env: None,
            timeout_secs: None,
        };
        let work = run_shell(cmd_for_task, Some(opts), Some(id_for_task.clone()));
        tokio::select! {
            r = work => {
                let mut e = entry_for_task.lock();
                e.info.finished_at = Some(now_unix());
                match r {
                    Ok(res) => { e.info.status = TaskStatus::Done; e.info.result = Some(res); }
                    Err(err) => { e.info.status = TaskStatus::Failed; e.info.error = Some(err); }
                }
            }
            _ = cancel_rx => {
                let mut e = entry_for_task.lock();
                e.info.status = TaskStatus::Cancelled;
                e.info.finished_at = Some(now_unix());
                // Forward cancellation to the run_shell handle (op_id == task id).
                crate::agent::cancel_shell(id_for_task.clone());
            }
        }
    }));
    Ok(info)
}

pub fn status(id: &str) -> Option<TaskInfo> {
    TASKS.lock().get(id).map(|e| e.lock().info.clone())
}

pub fn list() -> Vec<TaskInfo> {
    TASKS
        .lock()
        .values()
        .map(|e| e.lock().info.clone())
        .collect()
}

pub fn cancel(id: &str) -> Result<(), String> {
    let entry = TASKS
        .lock()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("no task {id}"))?;
    let mut g = entry.lock();
    if matches!(
        g.info.status,
        TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
    ) {
        return Ok(()); // already terminal
    }
    if let Some(tx) = g.cancel.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Drop terminal-state tasks older than `older_than_secs` seconds.
pub fn prune(older_than_secs: u64) -> usize {
    let now = now_unix();
    let mut to_remove = Vec::new();
    let map = TASKS.lock();
    for (id, entry) in map.iter() {
        // perf: read only the two scalar fields under the inner lock instead
        // of cloning the whole TaskInfo (which carries captured stdout/stderr).
        let g = entry.lock();
        let finished = matches!(
            g.info.status,
            TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
        );
        let finished_at = g.info.finished_at;
        drop(g);
        if finished {
            if let Some(t) = finished_at {
                if now.saturating_sub(t) >= older_than_secs {
                    to_remove.push(id.clone());
                }
            }
        }
    }
    drop(map);
    let mut map = TASKS.lock();
    let n = to_remove.len();
    for id in to_remove {
        map.remove(&id);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    // TASKS is process-global — serialize so tests don't collide with each
    // other or with any side-effect from create() in production code paths.
    static TEST_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    /// Helper: synthesize a terminal-state TaskEntry directly in the map
    /// without spawning a shell. Used by prune tests so we don't depend
    /// on a Tokio runtime or actually run a command.
    fn seed_terminal(id: &str, finished_at: u64, status: TaskStatus) {
        let entry = std::sync::Arc::new(parking_lot::Mutex::new(TaskEntry {
            info: TaskInfo {
                id: id.to_string(),
                command: "echo synthetic".to_string(),
                status,
                created_at: 0,
                finished_at: Some(finished_at),
                result: None,
                error: None,
            },
            cancel: None,
        }));
        TASKS.lock().insert(id.to_string(), entry);
    }

    fn clear_tasks() {
        TASKS.lock().clear();
    }

    #[test]
    fn prune_drops_old_terminal_tasks_only() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        let now = now_unix();
        seed_terminal("old-done", now - 3600, TaskStatus::Done);
        seed_terminal("recent-done", now, TaskStatus::Done);
        seed_terminal("old-failed", now - 3600, TaskStatus::Failed);

        // older_than_secs=600 → "old-*" drop (3600 >= 600), "recent-done" stays.
        let dropped = prune(600);
        assert_eq!(dropped, 2);
        assert!(status("old-done").is_none());
        assert!(status("old-failed").is_none());
        assert!(status("recent-done").is_some());

        clear_tasks();
    }

    #[test]
    fn prune_keeps_pending_or_running_regardless_of_age() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        let now = now_unix();
        // Synthesize a "running" task with no finished_at — must be untouched.
        let entry = std::sync::Arc::new(parking_lot::Mutex::new(TaskEntry {
            info: TaskInfo {
                id: "running".into(),
                command: "loop".into(),
                status: TaskStatus::Running,
                created_at: now - 7200,
                finished_at: None,
                result: None,
                error: None,
            },
            cancel: None,
        }));
        TASKS.lock().insert("running".into(), entry);

        seed_terminal("done-old", now - 7200, TaskStatus::Done);
        let dropped = prune(60);
        // Only the terminal task should drop; the running one survives.
        assert_eq!(dropped, 1);
        assert!(status("running").is_some());
        assert!(status("done-old").is_none());

        clear_tasks();
    }

    #[test]
    fn status_of_unknown_id_is_none() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        assert!(status("never-existed").is_none());
    }

    #[test]
    fn cancel_on_terminal_is_idempotent_ok() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        let now = now_unix();
        seed_terminal("already-done", now, TaskStatus::Done);
        // Cancel on a terminal task returns Ok(()) without flipping state.
        assert!(cancel("already-done").is_ok());
        let info = status("already-done").expect("still in map");
        assert_eq!(info.status, TaskStatus::Done);
        clear_tasks();
    }

    #[test]
    fn cancel_on_unknown_id_errors() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        let err = cancel("nope-not-here").unwrap_err();
        assert!(err.contains("no task"));
    }

    #[test]
    fn list_reflects_inserted_tasks() {
        let _g = TEST_LOCK.lock();
        clear_tasks();
        let now = now_unix();
        seed_terminal("a", now, TaskStatus::Done);
        seed_terminal("b", now, TaskStatus::Failed);
        let mut ids: Vec<String> = list().into_iter().map(|i| i.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
        clear_tasks();
    }
}
