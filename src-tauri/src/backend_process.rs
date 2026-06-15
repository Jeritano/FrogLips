//! Backend process lifecycle. Manages BOTH the MLX (`mlx_lm.server`) child
//! process and the externally-managed Ollama daemon — start/stop, readiness
//! probing, and stderr ring buffering for whichever backend is selected.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex as PLMutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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

/// Consecutive liveness-probe failures required before the watcher declares a
/// READY backend unresponsive. At the watcher's ~2s tick this is ~6s of no
/// answer, which tolerates a transient GC / weight-page pause without a
/// false-positive restart.
pub const UNRESPONSIVE_THRESHOLD: u32 = 3;

/// Should the watcher declare the backend unresponsive given the consecutive
/// failed-probe count so far? Pure helper so the threshold logic is unit-
/// testable in isolation from any socket. `consecutive` is the number of
/// liveness probes that have failed back-to-back (resets to 0 on any success).
pub fn is_unresponsive(consecutive: u32) -> bool {
    consecutive >= UNRESPONSIVE_THRESHOLD
}

/// Outcome of polling the server: what the watcher should do next.
pub enum WatchOutcome {
    /// Nothing changed, or the server is intentionally stopped.
    Idle,
    /// The running MLX child died unexpectedly — try to restart this model.
    Crashed { model: String, backend: String },
    /// A READY backend stopped answering its liveness probe for
    /// `UNRESPONSIVE_THRESHOLD` consecutive ticks (TCP open but HTTP wedged, or
    /// the port itself stopped accepting). `consecutive` is the streak length at
    /// the moment the threshold tripped. MLX is restartable via the existing
    /// backoff machinery; ollama (externally managed) is surfaced as degraded
    /// but never killed.
    Unresponsive {
        model: String,
        backend: String,
        consecutive: u32,
    },
}

#[derive(Default)]
pub struct ServerState {
    inner: Mutex<Option<RunningServer>>,
    app: PLMutex<Option<AppHandle>>,
    stderr_ring: Arc<PLMutex<VecDeque<String>>>,
    /// Which backend the lines currently in `stderr_ring` belong to (e.g.
    /// "mlx"). Set on every start() so `last_error()` / `dead_status()` can
    /// attribute the captured stderr to its source rather than reporting an
    /// orphaned blob. `None` when the ring is empty / no backend has run.
    /// Only the MLX child has piped stderr; ollama is externally managed and
    /// runs detached, so its label is set but the ring stays empty.
    ring_backend: PLMutex<Option<String>>,
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
    /// Consecutive failed liveness probes for the CURRENT ready backend (item
    /// 5). Reset to 0 on every successful probe, on start(), and on stop(). The
    /// watcher reads this via `poll()` and trips `WatchOutcome::Unresponsive`
    /// once it reaches `UNRESPONSIVE_THRESHOLD`. Only ever incremented while the
    /// backend is ready=true (a not-yet-ready backend is "still warming up", not
    /// unresponsive).
    unresponsive_streak: Arc<AtomicU32>,
    /// Last `server-status` payload actually emitted. The 2s watcher tick
    /// used to re-emit an unchanged status forever — every tick crossed the
    /// IPC bridge and re-rendered the React shell at idle (perf review
    /// M12/M30, 2026-06-09). Real transitions always differ field-wise
    /// (ready flip, model change, last_error update), so suppressing
    /// identical payloads loses nothing.
    last_emitted: PLMutex<Option<ServerStatus>>,
}

struct RunningServer {
    child: Option<Child>, // None for ollama (already running)
    model: String,
    backend: String,
}

#[derive(Serialize, Clone, PartialEq)]
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
            {
                let mut last = self.last_emitted.lock();
                if last.as_ref() == Some(status) {
                    return; // unchanged — skip the IPC + frontend re-render
                }
                *last = Some(status.clone());
            }
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
            // Attribute the captured stderr to the backend it came from so a UI
            // surfacing this last_error knows which process logged it (only the
            // MLX child pipes stderr today; the label future-proofs the readers).
            let label = self
                .ring_backend
                .lock()
                .clone()
                .unwrap_or_else(|| "backend".to_string());
            let joined = errors
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Some(format!("[{label}] {joined}"))
        }
    }

    fn clear_stderr(&self) {
        self.stderr_ring.lock().clear();
        *self.ring_backend.lock() = None;
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
        // Label the (about-to-be-populated) stderr ring with the backend being
        // started so last_error()/dead_status() can attribute it.
        *self.ring_backend.lock() = Some(backend.clone());
        self.ready.store(false, Ordering::Release);
        // Fresh backend → fresh liveness streak.
        self.unresponsive_streak.store(0, Ordering::Release);
        // A fresh start clears any pending intentional-stop flag — the watcher
        // should treat a future death of this new server as a crash.
        self.intentional_stop.store(false, Ordering::Release);
        // Invalidate any in-flight probe from a prior start
        let my_generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;

        if backend == "ollama" {
            // Probe the daemon so we don't claim ready while ollama is down.
            // First chat call would hang otherwise. TCP connect is cheap and
            // doesn't need an HTTP client dep.
            //
            // Audit MED (2026-05-28): retry with backoff instead of a single
            // connect. A daemon that's restarting (brew-services bounce,
            // systemd delay, or a just-launched `ollama serve`) can refuse
            // one connect then accept the next 200ms later; failing the
            // whole model load on a single transient ECONNREFUSED forced an
            // unnecessary user retry. Five attempts with a 200ms gap ≈ 1s
            // worst case before giving up — still well under the old single
            // 2s timeout in the common already-up case (first attempt wins).
            let addr = format!("{}:{}", OLLAMA_HOST, OLLAMA_PORT);
            let mut last_err: Option<String> = None;
            let mut connected = false;
            for attempt in 0..5 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                let probe = tokio::net::TcpStream::connect(&addr);
                match tokio::time::timeout(std::time::Duration::from_secs(2), probe).await {
                    Ok(Ok(_)) => {
                        connected = true;
                        break;
                    }
                    Ok(Err(e)) => last_err = Some(e.to_string()),
                    Err(_) => last_err = Some("connect timed out".to_string()),
                }
            }
            if !connected {
                // Inference perf O5 (2026-06-11): the port is CLOSED, so no
                // user-managed daemon exists to fight with — start our own
                // `ollama serve` (DETACHED, not tracked — see
                // spawn_ollama_daemon) so the env-only tuning knobs (flash
                // attention, KV q8_0, keep_alive) apply without user setup.
                // An externally-started daemon (port open) never reaches here.
                match spawn_ollama_daemon() {
                    Ok(()) => {
                        // Wait for the daemon to bind (cold start is slow).
                        for _ in 0..30 {
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            if tokio::time::timeout(
                                std::time::Duration::from_secs(1),
                                tokio::net::TcpStream::connect(&addr),
                            )
                            .await
                            .map(|r| r.is_ok())
                            .unwrap_or(false)
                            {
                                connected = true;
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        crate::diagnostics::warn_with(
                            "backend",
                            "ollama daemon spawn fallback failed",
                            serde_json::json!({ "error": e.to_string() }),
                        );
                        crate::health::set(
                            "backend",
                            crate::health::HealthState::Degraded,
                            &format!("ollama daemon spawn fallback failed: {e}"),
                        );
                    }
                }
            }
            if !connected {
                return Err(anyhow!(
                    "ollama daemon not reachable at {addr} after 5 attempts: {} — ensure `ollama serve` is running",
                    last_err.unwrap_or_else(|| "unknown".into()),
                ));
            }
            // Ollama is externally managed — never tracked as our child
            // (the spawned daemon, if any, runs detached).
            *guard = Some(RunningServer {
                child: None,
                model: model.clone(),
                backend: backend.clone(),
            });
            self.ready.store(true, Ordering::Release);
            // Recovery: the backend is reachable again — clear any degraded
            // health recorded by an earlier spawn-fallback failure.
            crate::health::clear("backend");
            return Ok(self.live_status(&model, &backend));
        }

        // MLX backend — spawn mlx_lm.server with captured stderr
        let binary =
            mlx_server_binary().context("mlx_lm.server not found — install: pip install mlx-lm")?;
        let mut cmd = Command::new(&binary);
        cmd.arg("--model")
            .arg(&model)
            .arg("--host")
            .arg(MLX_HOST)
            .arg("--port")
            .arg(MLX_PORT.to_string());
        // Inference perf M2/M5/M8 (2026-06-11): tuning flags, each gated on
        // the INSTALLED server's --help so an older mlx_lm never exits on an
        // unknown flag (which would read as "server won't start").
        //   --prefill-step-size 4096  → ~10-20% lower TTFT on long prompts
        //   --prompt-cache-size/-bytes → more chat switch-backs hit the KV
        //     cache AND caps a previously UNBOUNDED cache-growth path
        //   --draft-model (settings)  → speculative decoding, 1.5-2.5x
        //     decode on big models, output distribution unchanged
        //   --max-tokens (settings)   → default response length; the built-in
        //     512 truncates long replies. mlx_lm.server has NO context-window
        //     flag (context is fixed by the model config), so this is the only
        //     user-settable generation knob.
        let help = mlx_server_help(&binary).await;
        // Single settings read for every settings-driven MLX flag below.
        let mlx_settings = crate::settings::load();
        if help.contains("--prefill-step-size") {
            cmd.arg("--prefill-step-size").arg("4096");
        }
        if help.contains("--prompt-cache-size") {
            cmd.arg("--prompt-cache-size").arg("20");
        }
        if help.contains("--prompt-cache-bytes") {
            cmd.arg("--prompt-cache-bytes").arg("32G");
        }
        if help.contains("--draft-model") {
            if let Some(draft) = mlx_settings
                .mlx_draft_model
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
            {
                cmd.arg("--draft-model").arg(draft);
                if help.contains("--num-draft-tokens") {
                    cmd.arg("--num-draft-tokens").arg("3");
                }
            }
        }
        if help.contains("--max-tokens") {
            if let Some(max) = mlx_settings.mlx_max_tokens.filter(|n| *n > 0) {
                cmd.arg("--max-tokens").arg(max.to_string());
            }
        }
        let mut child = cmd
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
                    // Recovery: MLX port opened — clear any degraded health from
                    // a prior readiness timeout / crash on this subsystem.
                    crate::health::clear("backend");
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
            crate::health::set(
                "backend",
                crate::health::HealthState::Degraded,
                &format!(
                    "readiness probe timed out after 90s (model={model_for_probe}) — backend started but the HTTP port never opened"
                ),
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
        self.unresponsive_streak.store(0, Ordering::Release);
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
                let alive = guard
                    .as_ref()
                    .map(|s| (s.model.clone(), s.backend.clone()));
                let s = match guard.as_ref() {
                    Some(s) => self.live_status(&s.model, &s.backend),
                    None => self.dead_status(),
                };
                drop(guard);
                self.emit(&s);

                // Liveness probe (item 5). Only meaningful for a backend that is
                // alive AND has reported ready — a not-yet-ready backend is
                // "still warming up", not unresponsive. Gated behind the
                // `backend_liveness_probe` setting (default on). The probe runs
                // OUTSIDE the inner lock (already dropped) so a slow HTTP GET
                // never blocks start()/stop().
                if let Some((model, backend)) = alive {
                    if self.ready.load(Ordering::Acquire) && liveness_probe_enabled() {
                        // A wedged backend makes probe_responsive() block up to
                        // ~4s (2s TCP + 2s HTTP). Race it against the shutdown
                        // signal so app exit isn't delayed by a stuck probe
                        // (perf review 2026-06-14); the inter-tick sleep in the
                        // watcher is already shutdown-raced, but this in-poll
                        // await was not. The sticky-flag check covers the window
                        // where shutdown was requested before we parked on
                        // notified() (notify_waiters only wakes parked waiters).
                        if crate::is_shutting_down() {
                            return WatchOutcome::Idle;
                        }
                        let my_generation = self.generation.load(Ordering::Acquire);
                        let shutdown = crate::shutdown_signal();
                        let responsive = tokio::select! {
                            _ = shutdown.notified() => return WatchOutcome::Idle,
                            r = self.probe_responsive(&backend) => r,
                        };
                        // Discard the result if the backend was replaced/stopped
                        // while the probe was in flight — the streak belongs to
                        // whatever is running now, not the old generation.
                        if self.generation.load(Ordering::Acquire) != my_generation {
                            return WatchOutcome::Idle;
                        }
                        if responsive {
                            // Recovery: clear streak + any degraded health.
                            if self.unresponsive_streak.swap(0, Ordering::AcqRel) > 0 {
                                crate::health::clear("backend");
                            }
                        } else {
                            let consecutive =
                                self.unresponsive_streak.fetch_add(1, Ordering::AcqRel) + 1;
                            if is_unresponsive(consecutive) {
                                return WatchOutcome::Unresponsive {
                                    model,
                                    backend,
                                    consecutive,
                                };
                            }
                        }
                    }
                }
                WatchOutcome::Idle
            }
            Some((model, backend)) => {
                *guard = None;
                drop(guard);
                self.ready.store(false, Ordering::Release);
                self.unresponsive_streak.store(0, Ordering::Release);
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

    /// Lightweight liveness probe for the CURRENTLY-running backend (item 5).
    ///
    /// Stage 1 TCP-connects to the backend's port (~2s timeout); a closed port
    /// is not responsive. Stage 2 issues a cheap HTTP GET to a well-known
    /// endpoint (ollama `/api/version`, mlx `/v1/models`) with the same budget —
    /// TCP-open but HTTP-timeout means WEDGED, the key case the bare TCP check
    /// missed (the daemon accepts connections but its request loop is stuck).
    ///
    /// Returns `true` only when both stages succeed within the budget. Any
    /// non-2xx-or-timeout (incl. 5xx) counts as a failure for streak purposes: a
    /// backend returning 500 to its own health endpoint is not serving.
    pub async fn probe_responsive(&self, backend: &str) -> bool {
        const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
        let (host, port, path) = if backend == "ollama" {
            (OLLAMA_HOST, OLLAMA_PORT, "/api/version")
        } else {
            (MLX_HOST, MLX_PORT, "/v1/models")
        };
        // Stage 1: TCP connect.
        let addr = format!("{host}:{port}");
        let tcp_ok = matches!(
            tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(&addr)).await,
            Ok(Ok(_))
        );
        if !tcp_ok {
            return false;
        }
        // Stage 2: HTTP GET. Reuse a single long-lived client (perf review
        // 2026-06-14) instead of rebuilding one every ~2s tick — the builder
        // allocates a connection pool + TLS config each call. Cached in a
        // OnceLock; the per-probe timeout is set on the request, not the client,
        // so one shared client serves every backend.
        let url = format!("http://{host}:{port}{path}");
        match probe_client().get(&url).timeout(PROBE_TIMEOUT).send().await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false, // timeout / connection reset mid-request => wedged
        }
    }

    /// Emit a transient "unresponsive" status so the UI can surface a wedged
    /// backend. Used by the watcher's `Unresponsive` arm.
    ///
    /// Correctness (review 2026-06-14): an unresponsive backend is NOT dead —
    /// `poll()` only reaches the `Unresponsive` branch while the process is
    /// alive and the port is still open (the probe is "TCP open but HTTP
    /// wedged"). Building from `dead_status()` reported `running:false`,
    /// `host:""`, `port:0`, which is factually wrong and, for the ollama path
    /// (the watcher `continue`s with no follow-up emit), is the TERMINAL status
    /// the UI sees — a running daemon shown as process-dead with no connection
    /// info. Build from `live_status()` (keeps running:true + correct host/port)
    /// and override `ready=false` + set `last_error` so the UI shows
    /// "running but degraded" instead.
    pub fn emit_unresponsive(&self, model: &str, backend: &str, consecutive: u32) {
        let mut s = self.live_status(model, backend);
        s.ready = false;
        s.last_error = Some(format!(
            "{backend} backend stopped responding ({consecutive} consecutive failed liveness probes) — \
             the port is open but the server is not answering"
        ));
        self.emit(&s);
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

/// Spawn `ollama serve` as a tracked child with the tuned env that an
/// externally-managed daemon can't receive from us:
///   OLLAMA_FLASH_ATTENTION=1   — +5-20% tok/s on long context (Metal)
///   OLLAMA_KV_CACHE_TYPE=q8_0  — KV cache RAM −~50%, negligible quality loss
///   OLLAMA_KEEP_ALIVE          — settings-driven idle retention
///   OLLAMA_NUM_PARALLEL=1      — single-user app; parallel slots multiply KV
/// Only called when the port is CLOSED (no daemon to fight). PATH already
/// extended by ensure_path_for_gui for Finder/Dock launches.
/// Start `ollama serve` DETACHED, exactly as if the user ran it themselves
/// (post-bump review 2026-06-11). We do NOT track it as our child, for three
/// reasons. (1) kill_on_drop would SIGKILL `ollama serve`, orphaning the
/// `llama-server` runner it forks (leaked GPU/RAM + held port). (2) We only
/// reach here when port 11434 is CLOSED, and ollama's own bind exclusivity
/// makes a second `serve` from a concurrent launch just exit — no
/// single-instance guard needed. (3) Not killing it means a slow cold start
/// can't be torn down mid-load. The daemon outliving the app is identical to
/// user-launched ollama, and the lesser evil vs an orphaned runner holding
/// gigabytes of VRAM.
fn spawn_ollama_daemon() -> Result<()> {
    let keep = crate::settings::load()
        .ollama_keep_alive
        .unwrap_or_else(|| "30m".to_string());
    // kill_on_drop(false): dropping the handle leaves the OS process running.
    let _child = Command::new("ollama")
        .arg("serve")
        .env("OLLAMA_FLASH_ATTENTION", "1")
        .env("OLLAMA_KV_CACHE_TYPE", "q8_0")
        .env("OLLAMA_KEEP_ALIVE", keep)
        .env("OLLAMA_NUM_PARALLEL", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .context("spawn `ollama serve` (is ollama installed?)")?;
    Ok(())
}

/// Cached `mlx_lm.server --help` text — spawning a Python interpreter per
/// flag check would add ~300ms to every model start; once per app run is
/// enough (the binary doesn't change underneath a running app).
async fn mlx_server_help(binary: &std::path::Path) -> String {
    use tokio::sync::OnceCell;
    static HELP: OnceCell<String> = OnceCell::const_new();
    // get_or_try_init caches ONLY on Ok — a transient `--help` spawn failure
    // (e.g. mlx not yet installed) is NOT cached, so a later start retries
    // and picks up the tuning flags once mlx is present (post-bump review
    // 2026-06-11). A successful-but-empty help (unlikely) still caches.
    HELP.get_or_try_init(|| async {
        Command::new(binary)
            .arg("--help")
            .output()
            .await
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .cloned()
    .unwrap_or_default()
}

/// Whether the backend liveness probe is enabled (item 5). Reads the
/// `backend_liveness_probe` setting; absent/None => enabled (default on).
///
/// Perf (review 2026-06-14): the watcher calls this on EVERY ~2s poll tick
/// while a backend is ready. `settings::load()` is uncached and — when the user
/// has any `custom_backends`/`saved_apis` — resolves their secrets, which under
/// the Keychain-default backend means N+M `get_generic_password` round-trips +
/// secrets-file reads PER CALL. Hammering the Keychain every 2s for the entire
/// time a model is loaded is a regression introduced with the probe. Cache the
/// single boolean for a short TTL so the hot loop reads `settings::load()` (and
/// thus the Keychain) at most once per `LIVENESS_FLAG_TTL` instead of per tick.
/// The flag rarely changes; a stale-for-≤30s value is harmless and the next
/// re-read picks up any toggle.
fn liveness_probe_enabled() -> bool {
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    const LIVENESS_FLAG_TTL: Duration = Duration::from_secs(30);
    // (last_read_instant, cached_value). PLMutex keeps this lock-cheap and
    // poison-free; contention is nil (only the single watcher task calls it).
    static CACHE: OnceLock<PLMutex<Option<(Instant, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| PLMutex::new(None));

    let mut guard = cache.lock();
    if let Some((at, val)) = *guard {
        if at.elapsed() < LIVENESS_FLAG_TTL {
            return val;
        }
    }
    let val = crate::settings::load().backend_liveness_probe.unwrap_or(true);
    *guard = Some((Instant::now(), val));
    val
}

/// Long-lived reqwest client for the liveness probe (perf review 2026-06-14).
/// Rebuilding a client every ~2s tick reallocated a connection pool + TLS
/// config each time; one shared client (per-request timeout) eliminates that
/// churn. If the one-time build fails we fall back to a default client.
fn probe_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().unwrap_or_default())
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

    #[test]
    fn unresponsive_requires_n_consecutive_failures() {
        // Below the threshold (a single GC-pause-sized blip) must NOT trip.
        for streak in 0..UNRESPONSIVE_THRESHOLD {
            assert!(
                !is_unresponsive(streak),
                "streak {streak} should be tolerated"
            );
        }
        // At and above the threshold it trips.
        assert!(is_unresponsive(UNRESPONSIVE_THRESHOLD));
        assert!(is_unresponsive(UNRESPONSIVE_THRESHOLD + 10));
    }

    #[test]
    fn unresponsive_status_is_running_not_dead() {
        // Review 2026-06-14: an unresponsive (wedged-but-alive) backend must be
        // reported as running with the correct host/port — NOT process-dead with
        // an empty host and port 0. Mirror emit_unresponsive's status build
        // (live_status + ready=false override) and assert the live shape.
        let st = ServerState::default();
        st.ready.store(true, Ordering::Release); // backend was ready before wedging

        // ollama path: external daemon, port still open.
        let mut s = st.live_status("llama3", "ollama");
        s.ready = false;
        assert!(s.running, "wedged backend is alive, must report running:true");
        assert!(!s.ready, "wedged backend is not ready");
        assert_eq!(s.host, OLLAMA_HOST, "host must be preserved, not empty");
        assert_eq!(s.port, OLLAMA_PORT, "port must be preserved, not 0");
        assert_eq!(s.model.as_deref(), Some("llama3"));
        assert_eq!(s.backend.as_deref(), Some("ollama"));

        // mlx path: our child, port still open.
        let mut m = st.live_status("phi3", "mlx");
        m.ready = false;
        assert!(m.running);
        assert_eq!(m.host, MLX_HOST);
        assert_eq!(m.port, MLX_PORT);

        // Contrast: dead_status IS the empty/zeroed shape — what we must NOT use.
        let dead = st.dead_status();
        assert!(!dead.running);
        assert_eq!(dead.host, "");
        assert_eq!(dead.port, 0);
    }

    #[test]
    fn unresponsive_streak_simulation() {
        // Pure simulation of the watcher's streak accounting: a success resets
        // the streak, so two failures then a success then two more failures
        // never trips the 3-consecutive threshold.
        let mut streak = 0u32;
        let observe = |streak: &mut u32, responsive: bool| -> bool {
            if responsive {
                *streak = 0;
            } else {
                *streak += 1;
            }
            is_unresponsive(*streak)
        };
        assert!(!observe(&mut streak, false)); // 1
        assert!(!observe(&mut streak, false)); // 2
        assert!(!observe(&mut streak, true)); // reset → 0
        assert!(!observe(&mut streak, false)); // 1
        assert!(!observe(&mut streak, false)); // 2
        assert!(observe(&mut streak, false)); // 3 → trips
        // Three back-to-back from a clean slate trips exactly at the 3rd.
        let mut s2 = 0u32;
        assert!(!observe(&mut s2, false));
        assert!(!observe(&mut s2, false));
        assert!(observe(&mut s2, false));
    }
}
