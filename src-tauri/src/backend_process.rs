//! Backend process lifecycle. Manages BOTH the MLX (`mlx_lm.server`) child
//! process and the externally-managed Ollama daemon — start/stop, readiness
//! probing, and stderr ring buffering for whichever backend is selected.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex as PLMutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub const MLX_HOST: &str = "127.0.0.1";
pub const MLX_PORT: u16 = 8080;
pub const OLLAMA_HOST: &str = "127.0.0.1";
pub const OLLAMA_PORT: u16 = 11434;

const STDERR_RING_LINES: usize = 64;
/// Hard per-line cap when draining the MLX child's stderr. A model server
/// that prints one giant unterminated line would otherwise let tokio's
/// `next_line()` allocate without bound. The custom drainer below assembles
/// logical lines from a fixed-size scratch buffer and refuses to grow the
/// per-line carry Vec past this cap (overflow bytes are dropped until the
/// next `\n` arrives). 64 KiB is roomy vs typical MLX stderr (~1 KiB/line).
const STDERR_LINE_CAP: usize = 64 * 1024;

/// Max consecutive auto-restart attempts before the watcher gives up. A model
/// that crashes immediately on every launch must not loop forever.
pub const MAX_RESTART_ATTEMPTS: u32 = 3;

/// Backoff (seconds) before restart attempt `attempt` (1-indexed). Linear:
/// 2s, 4s, 6s. Pure helper so the capping logic is unit-testable.
pub fn restart_backoff_secs(attempt: u32) -> u64 {
    (attempt as u64) * 2
}

/// Should the watcher attempt another restart given how many have been tried?
/// `attempts_done` is the count of restarts already attempted this crash run.
/// Pure helper — unit-tested in isolation from the process machinery.
pub fn should_attempt_restart(attempts_done: u32) -> bool {
    attempts_done < MAX_RESTART_ATTEMPTS
}

/// Outcome of polling the server: what the watcher should do next.
pub enum WatchOutcome {
    /// Nothing changed, or the server is intentionally stopped.
    Idle,
    /// The running MLX child died unexpectedly — try to restart this model.
    Crashed { model: String, backend: String },
}

#[derive(Default)]
pub struct ServerState {
    inner: Mutex<Option<RunningServer>>,
    app: PLMutex<Option<AppHandle>>,
    stderr_ring: Arc<PLMutex<VecDeque<String>>>,
    /// True once the MLX/Ollama backend has accepted a TCP connection on its
    /// port. Used so the UI can distinguish "process running" from
    /// "ready to serve requests" (MLX takes 10-60s to load a model).
    ready: Arc<AtomicBool>,
    /// Incremented on every start() and stop(). Background tasks capture the
    /// value at spawn time and bail if it has changed when they wake up —
    /// prevents stale probes from reporting ready=true for a server that has
    /// since been stopped or replaced.
    generation: Arc<AtomicU64>,
    /// Set true by stop(), cleared by start(). Lets the watcher tell an
    /// intentional shutdown apart from an unexpected crash so a user-initiated
    /// stop never triggers auto-restart.
    intentional_stop: Arc<AtomicBool>,
}

struct RunningServer {
    child: Option<Child>, // None for ollama (already running)
    model: String,
    backend: String,
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    /// True when the backend port accepts TCP connections. For Ollama this is
    /// set during start(); for MLX this flips after the model finishes loading.
    pub ready: bool,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub host: String,
    pub port: u16,
    pub last_error: Option<String>,
}

impl ServerState {
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    fn emit(&self, status: &ServerStatus) {
        if let Some(app) = self.app.lock().clone() {
            let _ = app.emit("server-status", status);
        }
    }

    fn last_error(&self) -> Option<String> {
        // Filter to lines that actually look like errors. MLX prints normal
        // startup info (loading model, server URL, etc.) to stderr; without
        // filtering, those would be reported as "last_error" on the UI.
        let ring = self.stderr_ring.lock();
        let errors: Vec<&String> = ring
            .iter()
            .filter(|l| {
                let lc = l.to_ascii_lowercase();
                lc.contains("error")
                    || lc.contains("traceback")
                    || lc.contains("exception")
                    || lc.contains("failed")
                    || l.starts_with("  File \"") // python stack frames
            })
            .collect();
        if errors.is_empty() {
            None
        } else {
            Some(
                errors
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
    }

    fn clear_stderr(&self) {
        self.stderr_ring.lock().clear();
    }

    pub async fn start(&self, model: String, backend: String) -> Result<ServerStatus> {
        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.as_mut() {
            if existing.model == model && existing.backend == backend {
                return Ok(self.live_status(&existing.model, &existing.backend));
            }
            if let Some(child) = existing.child.as_mut() {
                kill_child(child).await;
            }
        }
        self.clear_stderr();
        self.ready.store(false, Ordering::Release);
        // A fresh start clears any pending intentional-stop flag — the watcher
        // should treat a future death of this new server as a crash.
        self.intentional_stop.store(false, Ordering::Release);
        // Invalidate any in-flight probe from a prior start
        let my_generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;

        if backend == "ollama" {
            // Probe the daemon so we don't claim ready while ollama is down.
            // First chat call would hang otherwise. TCP connect is cheap and
            // doesn't need an HTTP client dep.
            let addr = format!("{}:{}", OLLAMA_HOST, OLLAMA_PORT);
            let probe = tokio::net::TcpStream::connect(&addr);
            tokio::time::timeout(std::time::Duration::from_secs(2), probe)
                .await
                .map_err(|_| anyhow!("ollama daemon probe timed out at {addr}"))?
                .map_err(|e| anyhow!("ollama daemon not reachable at {addr}: {e}"))?;
            *guard = Some(RunningServer {
                child: None,
                model: model.clone(),
                backend: backend.clone(),
            });
            self.ready.store(true, Ordering::Release);
            return Ok(self.live_status(&model, &backend));
        }

        // MLX backend — spawn mlx_lm.server with captured stderr
        let binary =
            mlx_server_binary().context("mlx_lm.server not found — install: pip install mlx-lm")?;
        let mut child = Command::new(&binary)
            .arg("--model")
            .arg(&model)
            .arg("--host")
            .arg(MLX_HOST)
            .arg("--port")
            .arg(MLX_PORT.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn {}", binary.display()))?;

        // Pump stderr into a bounded ring
        if let Some(stderr) = child.stderr.take() {
            let ring = self.stderr_ring.clone();
            let generation = self.generation.clone();
            tokio::spawn(async move {
                // Tokio's `next_line()` reads a logical line with no per-line
                // cap — a model server that prints one massive line without
                // `\n` would let the buffer grow unbounded. We instead read
                // into a fixed-size stack buffer and assemble logical lines
                // by hand: when a single line exceeds STDERR_LINE_CAP we
                // truncate at the cap and discard until the next `\n`, then
                // resume normally. The `carry` Vec is bounded by the cap.
                let mut reader = BufReader::new(stderr);
                let cap = STDERR_LINE_CAP;
                let mut scratch = [0u8; 4096];
                let mut carry: Vec<u8> = Vec::with_capacity(1024);
                let mut discarding = false; // true once this line has hit the cap
                loop {
                    let n: usize = reader.read(&mut scratch).await.unwrap_or_default();
                    if n == 0 {
                        // EOF — emit any partial line we still have, then exit.
                        if !carry.is_empty() {
                            let line = String::from_utf8_lossy(&carry).into_owned();
                            if generation.load(Ordering::Acquire) == my_generation {
                                let mut r = ring.lock();
                                if r.len() >= STDERR_RING_LINES {
                                    r.pop_front();
                                }
                                r.push_back(line);
                            }
                        }
                        break;
                    }
                    let mut i = 0;
                    while i < n {
                        match scratch[..n].iter().skip(i).position(|&b| b == b'\n') {
                            Some(rel) => {
                                let nl = i + rel;
                                if !discarding {
                                    let room = cap.saturating_sub(carry.len());
                                    let take = (nl - i).min(room);
                                    carry.extend_from_slice(&scratch[i..i + take]);
                                    if take < nl - i {
                                        // Overflow within this line — mark
                                        // truncated but don't grow further.
                                        discarding = true;
                                    }
                                }
                                let mut line = String::from_utf8_lossy(&carry).into_owned();
                                if discarding {
                                    line.push_str(" [line truncated]");
                                }
                                carry.clear();
                                discarding = false;
                                if generation.load(Ordering::Acquire) != my_generation {
                                    return;
                                }
                                let mut r = ring.lock();
                                if r.len() >= STDERR_RING_LINES {
                                    r.pop_front();
                                }
                                r.push_back(line);
                                i = nl + 1;
                            }
                            None => {
                                if !discarding {
                                    let room = cap.saturating_sub(carry.len());
                                    let take = (n - i).min(room);
                                    carry.extend_from_slice(&scratch[i..i + take]);
                                    if take < n - i {
                                        discarding = true;
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            });
        }

        // The watcher in lib.rs::setup polls `status()` periodically and detects
        // natural child death there; no per-server watcher task needed here.
        *guard = Some(RunningServer {
            child: Some(child),
            model: model.clone(),
            backend: backend.clone(),
        });
        drop(guard);

        // Background readiness probe: poll TCP every 500ms for up to 90s.
        // Bails immediately if the server generation changed (stop/restart),
        // so a stale probe can't flip ready=true on a server it doesn't own.
        let ready = self.ready.clone();
        let generation = self.generation.clone();
        let app = self.app.lock().clone();
        let model_for_probe = model.clone();
        let backend_for_probe = backend.clone();
        tokio::spawn(async move {
            let addr = format!("{}:{}", MLX_HOST, MLX_PORT);
            let mut iterations = 0u32;
            for _ in 0..180 {
                iterations += 1;
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if generation.load(Ordering::Acquire) != my_generation {
                    return; // server stopped or replaced
                }
                // Staged liveness diagnostics (audit HIGH 2026-05-28).
                // At 500 ms/iter the 90 s probe was previously silent
                // until the final timeout, so a slow-but-healthy cold
                // load (weights still downloading) was indistinguishable
                // from a hung/misconfigured backend. Emit a heartbeat at
                // 10 s / 30 s / 60 s so the UI + Diagnostics panel show
                // progress and the user can tell "still loading" from
                // "stuck". Only fires while the port is NOT yet open.
                if matches!(iterations, 20 | 60 | 120) {
                    let secs = iterations / 2;
                    crate::diagnostics::info(
                        "backend-process",
                        &format!(
                            "MLX backend still warming up after {secs}s (model={model_for_probe}, \
                             backend={backend_for_probe}) — port not open yet. Cold loads download \
                             + map weights; large models can take 1-2 min."
                        ),
                    );
                }
                let probe = tokio::net::TcpStream::connect(&addr);
                if tokio::time::timeout(std::time::Duration::from_millis(200), probe)
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                    .is_some()
                {
                    // Three generation re-checks bracket the flip:
                    //   (1) before ready.store — already present
                    //   (2) AFTER ready.store but before emit — closes the
                    //       window where a competing `start(modelB)` lands
                    //       between (1) and the emit, which would otherwise
                    //       broadcast `ready=true` for the old model.
                    //   (3) the lifetime watcher in status() also re-checks
                    //       via the inner.lock state.
                    if generation.load(Ordering::Acquire) != my_generation {
                        return;
                    }
                    ready.store(true, Ordering::Release);
                    // (2) Post-store, pre-emit re-check.
                    if generation.load(Ordering::Acquire) != my_generation {
                        return;
                    }
                    if let Some(app) = app {
                        let _ = app.emit(
                            "server-status",
                            &ServerStatus {
                                running: true,
                                ready: true,
                                model: Some(model_for_probe),
                                backend: Some(backend_for_probe),
                                host: MLX_HOST.into(),
                                port: MLX_PORT,
                                last_error: None,
                            },
                        );
                    }
                    return;
                }
            }
            // Probe ran the full 180 iterations × 500ms ≈ 90s and never
            // saw the port open. Without this diag the user sees
            // running=true, ready=false forever with no signal why
            // (audit M4, 2026-05-27). Emit a structured warning + an
            // error-shaped server-status so the UI can surface it.
            if generation.load(Ordering::Acquire) != my_generation {
                return;
            }
            crate::diagnostics::warn_with(
                "backend-process",
                &format!(
                    "readiness probe timed out after {} iterations against {} (model={}, backend={})",
                    iterations, addr, model_for_probe, backend_for_probe
                ),
                serde_json::Value::Null,
            );
            if let Some(app) = app {
                let _ = app.emit(
                    "server-status",
                    &ServerStatus {
                        running: true,
                        ready: false,
                        model: Some(model_for_probe.clone()),
                        backend: Some(backend_for_probe.clone()),
                        host: MLX_HOST.into(),
                        port: MLX_PORT,
                        last_error: Some(format!(
                            "Readiness probe timed out after 90s — backend started but the HTTP port \
                             never opened. Check the model name ({}) and the backend logs.",
                            model_for_probe
                        )),
                    },
                );
            }
        });

        let status = self.live_status(&model, &backend);
        self.emit(&status);
        Ok(status)
    }

    pub async fn stop(&self) {
        // Mark intentional BEFORE killing so a watcher poll racing this stop
        // sees the flag and never misclassifies the kill as a crash.
        self.intentional_stop.store(true, Ordering::Release);
        let mut guard = self.inner.lock().await;
        if let Some(mut s) = guard.take() {
            if let Some(child) = s.child.as_mut() {
                kill_child(child).await;
            }
        }
        drop(guard);
        self.ready.store(false, Ordering::Release);
        // Invalidate any in-flight probe so it can't emit ready=true after stop
        self.generation.fetch_add(1, Ordering::AcqRel);
        let s = self.dead_status();
        self.emit(&s);
    }

    /// Poll the running server for the watcher loop. Unlike `status()`, this
    /// reports whether a death was an unexpected crash (eligible for
    /// auto-restart) versus an intentional stop, and returns the dead server's
    /// model/backend so the watcher can relaunch it.
    pub async fn poll(&self) -> WatchOutcome {
        let mut guard = self.inner.lock().await;
        let dead = match guard.as_mut() {
            Some(s) => match s.child.as_mut() {
                None => None,
                Some(child) => match child.try_wait() {
                    Ok(None) => None,
                    _ => Some((s.model.clone(), s.backend.clone())),
                },
            },
            None => None,
        };
        match dead {
            None => {
                // Mirror status()'s emit for the no-death path.
                let s = match guard.as_ref() {
                    Some(s) => self.live_status(&s.model, &s.backend),
                    None => self.dead_status(),
                };
                drop(guard);
                self.emit(&s);
                WatchOutcome::Idle
            }
            Some((model, backend)) => {
                *guard = None;
                drop(guard);
                self.ready.store(false, Ordering::Release);
                // Bump generation so stale probes from the dead process bail.
                self.generation.fetch_add(1, Ordering::AcqRel);
                if self.intentional_stop.load(Ordering::Acquire) {
                    let s = self.dead_status();
                    self.emit(&s);
                    WatchOutcome::Idle
                } else {
                    WatchOutcome::Crashed { model, backend }
                }
            }
        }
    }

    /// Emit a transient "restarting" status so the UI can show progress while
    /// the watcher backs off and relaunches a crashed model server.
    pub fn emit_restarting(&self, model: &str, backend: &str, attempt: u32) {
        let mut s = self.dead_status();
        s.model = Some(model.into());
        s.backend = Some(backend.into());
        s.last_error = Some(format!(
            "model server crashed — restarting (attempt {attempt}/{MAX_RESTART_ATTEMPTS})"
        ));
        self.emit(&s);
    }

    /// Emit a terminal "gave up" status after exhausting restart attempts.
    pub fn emit_gave_up(&self, attempts: u32) {
        let mut s = self.dead_status();
        let detail = s
            .last_error
            .take()
            .map(|e| format!(" — check the model / logs:\n{e}"))
            .unwrap_or_else(|| " — check the model / logs".into());
        s.last_error = Some(format!(
            "model server crashed {attempts} times, giving up{detail}"
        ));
        self.emit(&s);
    }

    pub async fn status(&self) -> ServerStatus {
        let mut guard = self.inner.lock().await;
        let died = match guard.as_mut() {
            Some(s) => match s.child.as_mut() {
                None => false,
                Some(child) => !matches!(child.try_wait(), Ok(None)),
            },
            None => false,
        };
        if died {
            *guard = None;
            drop(guard);
            self.ready.store(false, Ordering::Release);
            let s = self.dead_status();
            self.emit(&s);
            return s;
        }
        match guard.as_ref() {
            Some(s) => self.live_status(&s.model, &s.backend),
            None => self.dead_status(),
        }
    }

    fn live_status(&self, model: &str, backend: &str) -> ServerStatus {
        let (host, port) = if backend == "ollama" {
            (OLLAMA_HOST, OLLAMA_PORT)
        } else {
            (MLX_HOST, MLX_PORT)
        };
        ServerStatus {
            running: true,
            ready: self.ready.load(Ordering::Acquire),
            model: Some(model.into()),
            backend: Some(backend.into()),
            host: host.into(),
            port,
            last_error: None,
        }
    }

    fn dead_status(&self) -> ServerStatus {
        ServerStatus {
            running: false,
            ready: false,
            model: None,
            backend: None,
            host: String::new(),
            port: 0,
            last_error: self.last_error(),
        }
    }
}

async fn kill_child(child: &mut Child) {
    // `tokio::process::Child::kill()` already sends SIGKILL on Unix — no
    // SIGTERM-first courtesy step. If the wait times out the process is in
    // uninterruptible kernel state (Metal driver hang, FUSE blocked, etc.)
    // and we can't reap it cleanly. Infra audit H3: log the PID so the
    // next-launch port probe can detect "port still in use, kill by PID"
    // and the user has a breadcrumb instead of a silent zombie.
    let pid_for_log = child.id();
    let _ = child.kill().await;
    let reaped = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
    if reaped.is_err() {
        if let Some(pid) = pid_for_log {
            crate::diagnostics::warn_with(
                "backend",
                &format!(
                    "child pid {pid} did not reap within 3s of SIGKILL — \
                     possible kernel-state hang; next-launch port probe may need to \
                     reclaim the port manually"
                ),
                serde_json::json!({ "pid": pid }),
            );
        }
    }
}

fn mlx_server_binary() -> Result<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let candidate = home.join(".venvs/mlx/bin/mlx_lm.server");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    which("mlx_lm.server").ok_or_else(|| anyhow!("mlx_lm.server not found on PATH"))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_attempts_are_capped() {
        // First MAX_RESTART_ATTEMPTS tries are allowed...
        for done in 0..MAX_RESTART_ATTEMPTS {
            assert!(
                should_attempt_restart(done),
                "attempt {done} should proceed"
            );
        }
        // ...then the watcher must give up.
        assert!(!should_attempt_restart(MAX_RESTART_ATTEMPTS));
        assert!(!should_attempt_restart(MAX_RESTART_ATTEMPTS + 5));
    }

    #[test]
    fn restart_loop_terminates() {
        // Simulate a model that crashes on every launch: the attempt counter
        // must reach the cap and stop, never looping unbounded.
        let mut attempts = 0u32;
        while should_attempt_restart(attempts) {
            attempts += 1;
            assert!(attempts <= MAX_RESTART_ATTEMPTS, "loop exceeded cap");
        }
        assert_eq!(attempts, MAX_RESTART_ATTEMPTS);
    }

    #[test]
    fn backoff_increases_per_attempt() {
        assert_eq!(restart_backoff_secs(1), 2);
        assert_eq!(restart_backoff_secs(2), 4);
        assert_eq!(restart_backoff_secs(3), 6);
        assert!(restart_backoff_secs(2) > restart_backoff_secs(1));
    }
}
