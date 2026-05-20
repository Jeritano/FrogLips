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
use tokio::task::JoinHandle;

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
    handle: Option<JoinHandle<()>>,
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
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("task-{:x}-{:x}", nanos, rand_seed())
}

fn rand_seed() -> u32 {
    // Cheap, not cryptographic — only used to avoid collisions on same-nanosecond calls.
    use std::cell::Cell;
    thread_local!(static SEED: Cell<u32> = const { Cell::new(0xdead_beef) });
    SEED.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s.set(x);
        x
    })
}

pub fn create(command: String, cwd: Option<String>) -> Result<TaskInfo, String> {
    if TASKS.lock().len() >= MAX_CONCURRENT_TASKS {
        return Err(format!(
            "task queue full ({MAX_CONCURRENT_TASKS} active) — cancel finished ones first"
        ));
    }
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
        handle: None,
        cancel: Some(cancel_tx),
    }));
    let entry_for_task = entry.clone();
    let id_for_task = id.clone();
    let cmd_for_task = command;
    let cwd_for_task = cwd;
    let handle = tokio::spawn(async move {
        // Flip to Running
        entry_for_task.lock().info.status = TaskStatus::Running;

        let opts = ShellOpts {
            cwd: cwd_for_task,
            env: None,
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
    });
    entry.lock().handle = Some(handle);
    let info = entry.lock().info.clone();
    TASKS.lock().insert(id.clone(), entry);
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
        let info = entry.lock().info.clone();
        let finished = matches!(
            info.status,
            TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
        );
        if finished {
            if let Some(t) = info.finished_at {
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
