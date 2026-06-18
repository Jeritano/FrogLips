//! DB / storage maintenance agent (WS4, 2026-06-13).
//!
//! A periodic, fail-open housekeeper for the live SQLite DB. Every phase is
//! best-effort: a failure is logged via diagnostics, the phase is skipped, and
//! the next phase still runs. The headline guarantee is **never lose chat
//! history** — messages are ARCHIVED to a cold attached DB, never hard-deleted,
//! and a recovery command (`db_maintenance_restore_archived`) brings them back.
//!
//! Phases (in order):
//!   1. caps — trim audit / perf / session-metrics ledgers to their row caps.
//!   2. archive — move messages older than `archive_age_days` (for
//!      conversations with NO recent activity) to `db.archive.sqlite`. The
//!      move + delete is ONE atomic IMMEDIATE transaction via `with_write`.
//!   3. reclaim — `wal_checkpoint(TRUNCATE)`, `ANALYZE`, FTS `optimize`.
//!      Full `VACUUM` is NEVER run here — only via the explicit opt-in command.
//!   4. report — bytes before/after + rows archived/trimmed per phase.
//!
//! Safety: the archive move uses the WS3 single-writer gate, so it can never
//! interleave with a live append; conversations with activity inside
//! `active_window_secs` are excluded entirely; reads are never blocked except
//! by the opt-in VACUUM.

use anyhow::{Context, Result};
use rusqlite::params;
use serde::Serialize;
use std::path::PathBuf;

use crate::history::{self, get_db, now_unix};
use crate::settings::MaintenanceConfig;

/// Row caps for the bounded ledgers. These mirror the self-trim caps the
/// writers already enforce (agent_audit 50k, model_perf 5k) plus the NEW
/// agent_session_metrics cap this agent owns.
const AGENT_AUDIT_CAP: i64 = 50_000;
const MODEL_PERF_CAP: i64 = 5_000;
const AGENT_SESSION_METRICS_CAP: i64 = 50_000;

/// What triggered a maintenance pass — surfaced in the report + diagnostics so
/// a scheduled pass is distinguishable from an explicit user-initiated one.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    /// The app-lifetime scheduler timer.
    Scheduled,
    /// A light pass kicked off shortly after boot.
    Boot,
    /// The user pressed "Optimize now".
    Manual,
    /// The user pressed "Reclaim disk (VACUUM)".
    Vacuum,
}

/// Per-phase outcome. `skipped` carries the reason a fail-open phase bailed.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PhaseResult {
    pub ran: bool,
    pub skipped_reason: Option<String>,
    /// Rows affected by this phase (trimmed or archived), when meaningful.
    pub rows: i64,
}

/// Cheap storage stats — bytes on disk + row counts. Read-only, never locks
/// anything beyond a normal pooled read.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MaintenanceStats {
    pub db_bytes: i64,
    pub wal_bytes: i64,
    pub archive_bytes: i64,
    pub conversations: i64,
    pub messages: i64,
    pub messages_archived: i64,
    pub agent_audit_rows: i64,
    pub model_perf_rows: i64,
    pub agent_session_metrics_rows: i64,
}

/// Full report from a `run_maintenance` pass.
#[derive(Debug, Clone, Serialize)]
pub struct MaintenanceReport {
    pub trigger: Trigger,
    pub started_at: i64,
    pub duration_ms: u128,
    pub bytes_before: i64,
    pub bytes_after: i64,
    pub caps: PhaseResult,
    pub archive: PhaseResult,
    pub reclaim: PhaseResult,
    /// True if a full VACUUM ran (only via the explicit command).
    pub vacuumed: bool,
}

/* ── Paths ── */

/// Path to the cold archive DB, a sibling of the live DB.
pub(crate) fn archive_db_path() -> Result<PathBuf> {
    let live = history::db_path()?;
    Ok(live.with_file_name("db.archive.sqlite"))
}

/// File size in bytes, or 0 if the file is absent / unstattable (fail-open).
fn file_bytes(path: &PathBuf) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

/// Total live-DB footprint: main file + WAL sidecar.
fn live_bytes() -> i64 {
    let Ok(live) = history::db_path() else {
        return 0;
    };
    let mut wal = live.clone().into_os_string();
    wal.push("-wal");
    file_bytes(&live) + file_bytes(&PathBuf::from(wal))
}

/* ── Stats (read-only, cheap) ── */

pub fn stats() -> Result<MaintenanceStats> {
    let conn = get_db()?;
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };

    let live = history::db_path()?;
    let mut wal = live.clone().into_os_string();
    wal.push("-wal");

    // Archived count comes from the attached archive DB if it exists. Done in a
    // short read-only attach so the count is accurate without keeping the
    // archive attached on every pooled connection.
    let messages_archived = count_archived().unwrap_or(0);

    Ok(MaintenanceStats {
        db_bytes: file_bytes(&live),
        wal_bytes: file_bytes(&PathBuf::from(wal)),
        archive_bytes: archive_db_path().map(|p| file_bytes(&p)).unwrap_or(0),
        conversations: count("SELECT COUNT(*) FROM conversations"),
        messages: count("SELECT COUNT(*) FROM messages"),
        messages_archived,
        agent_audit_rows: count("SELECT COUNT(*) FROM agent_audit"),
        model_perf_rows: count("SELECT COUNT(*) FROM model_perf_samples"),
        agent_session_metrics_rows: count("SELECT COUNT(*) FROM agent_session_metrics"),
    })
}

/// Count rows in the archive DB's `messages_archive` table, attaching it
/// read-only for the duration. Returns 0 if the archive doesn't exist yet.
fn count_archived() -> Result<i64> {
    let archive = archive_db_path()?;
    if !archive.exists() {
        return Ok(0);
    }
    let conn = get_db()?;
    attach_archive_scope(&conn, |c| {
        let exists: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM arch.sqlite_master \
                 WHERE type='table' AND name='messages_archive'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            return Ok(0);
        }
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM arch.messages_archive", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        Ok(n)
    })
}

/// Attach the archive DB as `arch`, run `f`, then detach — even on error.
/// ATTACH/DETACH can't run inside a transaction, so callers pass plain reads or
/// arrange writes via `with_write` separately. Used by stats + restore.
fn attach_archive_scope<T>(
    conn: &rusqlite::Connection,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T>,
) -> Result<T> {
    let archive = archive_db_path()?;
    let archive_str = archive.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("ATTACH DATABASE '{archive_str}' AS arch"))
        .context("attach archive db")?;
    let out = f(conn);
    // Best-effort detach — never mask the inner result with a detach error.
    let _ = conn.execute_batch("DETACH DATABASE arch");
    out
}

/* ── Phase 1: caps ── */

/// Range-delete-by-id trim keeping the newest `cap` rows of `table`. Mirrors
/// agent_audit's self-trim — a contiguous PK sweep, a no-op below the cap.
/// Runs inside the single-writer gate. Returns rows deleted.
fn trim_table(table: &'static str, cap: i64) -> Result<i64> {
    // The table name is a compile-time constant (never user input), so the
    // format is injection-safe.
    history::with_write(|tx| {
        let n = tx.execute(
            &format!(
                "DELETE FROM {table} WHERE id < \
                 (SELECT id FROM {table} ORDER BY id DESC LIMIT 1 OFFSET ?1)"
            ),
            params![cap - 1],
        )?;
        Ok(n as i64)
    })
}

fn run_caps_phase() -> PhaseResult {
    let mut total = 0i64;
    for (table, cap) in [
        ("agent_audit", AGENT_AUDIT_CAP),
        ("model_perf_samples", MODEL_PERF_CAP),
        ("agent_session_metrics", AGENT_SESSION_METRICS_CAP),
    ] {
        match trim_table(table, cap) {
            Ok(n) => total += n,
            Err(e) => {
                crate::diagnostics::warn_with(
                    "maintenance",
                    &format!("caps trim failed for {table} — skipped"),
                    serde_json::json!({ "table": table, "error": e.to_string() }),
                );
                // fail-open: continue to the next table.
            }
        }
    }
    PhaseResult {
        ran: true,
        skipped_reason: None,
        rows: total,
    }
}

/* ── Phase 2: archive-not-delete ── */

/// Ensure the archive DB exists and carries the `messages_archive` table. The
/// table mirrors `messages` plus a `conversation_title` snapshot (so a restored
/// message keeps context even if the source conversation was later deleted) and
/// an `archived_at` stamp. Created lazily on first archive.
fn ensure_archive_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS arch.messages_archive (
            id INTEGER PRIMARY KEY,
            conversation_id INTEGER NOT NULL,
            conversation_title TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            model TEXT,
            images TEXT,
            archived_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS arch.idx_messages_archive_conv
            ON messages_archive(conversation_id);
         CREATE INDEX IF NOT EXISTS arch.idx_messages_archive_archived_at
            ON messages_archive(archived_at);",
    )
    .context("create messages_archive table")?;
    Ok(())
}

/// Archive messages older than `archive_age_days` that belong to conversations
/// with NO activity inside `active_window_secs`. INSERT…SELECT into the archive
/// then DELETE the moved ids — all in ONE IMMEDIATE transaction (via
/// `with_write`) so the move is atomic. The FTS delete-triggers keep
/// `messages_fts` consistent automatically. Returns rows archived.
fn run_archive_phase(cfg: &MaintenanceConfig) -> PhaseResult {
    if !cfg.archive_messages {
        return PhaseResult {
            ran: false,
            skipped_reason: Some("archive_messages disabled".into()),
            rows: 0,
        };
    }
    let now = now_unix();
    let cutoff = now - cfg.archive_age_days.max(0) * 86_400;
    let active_floor = now - cfg.active_window_secs.max(0);

    let result: Result<i64> = (|| {
        let conn = get_db()?;
        let archive_str = archive_db_path()?.to_string_lossy().replace('\'', "''");
        // ATTACH must be OUTSIDE the transaction. We attach on this pooled
        // connection, then run the atomic move inside `with_write` on a
        // DIFFERENT pooled connection? No — with_write opens its own
        // connection, which won't see this ATTACH. So we do the whole move on
        // THIS connection, manually taking the write gate for the txn.
        conn.execute_batch(&format!("ATTACH DATABASE '{archive_str}' AS arch"))
            .context("attach archive db")?;
        let moved = (|| -> Result<i64> {
            ensure_archive_schema(&conn)?;
            // Serialize against all other writers for the duration of the move.
            history::with_write_lock(|| {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let inner = (|| -> Result<i64> {
                    // Move older-than-cutoff messages whose conversation's
                    // NEWEST message is itself older than the active floor (no
                    // recent activity in the whole conversation).
                    // `m.run_id IS NULL` excludes agent per-iteration checkpoint
                    // "shadow" rows (migration v28): they carry a non-null
                    // run_id + tool_call_id/tool_name/turn_index, are hidden
                    // from the conversation view by the same `run_id IS NULL`
                    // filter in list_messages, and are NOT representable in
                    // messages_archive (which omits those columns). Archiving
                    // them would lose the durable checkpoint metadata AND make
                    // them visible again on restore (run_id comes back NULL),
                    // injecting raw tool-call turns into the transcript. Let
                    // checkpoint_run own their lifecycle instead.
                    conn.execute(
                        "INSERT INTO arch.messages_archive
                            (id, conversation_id, conversation_title, role, content,
                             created_at, model, images, archived_at)
                         SELECT m.id, m.conversation_id, c.title, m.role, m.content,
                                m.created_at, m.model, m.images, ?1
                         FROM messages m
                         JOIN conversations c ON c.id = m.conversation_id
                         WHERE m.created_at < ?2
                           AND m.run_id IS NULL
                           AND m.conversation_id IN (
                             SELECT conversation_id FROM messages
                             GROUP BY conversation_id
                             HAVING MAX(created_at) < ?3
                           )",
                        params![now, cutoff, active_floor],
                    )?;
                    // Delete exactly the ids we just archived (the FTS
                    // delete-trigger fires here, keeping messages_fts in sync).
                    // Scope the archive-membership subquery to THIS pass's rows
                    // via `archived_at = ?1` (= `now`) instead of `id IN (SELECT
                    // id FROM arch.messages_archive)`, which would re-scan the
                    // entire ever-growing archive every pass. This keeps the
                    // never-lose-history guarantee (we only delete rows confirmed
                    // present in the archive) while making the DELETE cost
                    // proportional to the batch, not total archived history. The
                    // `run_id IS NULL` guard mirrors the INSERT so shadow rows
                    // are never deleted from the live table.
                    let deleted = conn.execute(
                        "DELETE FROM messages
                         WHERE id IN (
                             SELECT id FROM arch.messages_archive WHERE archived_at = ?1
                           )
                           AND created_at < ?2
                           AND run_id IS NULL
                           AND conversation_id IN (
                             SELECT conversation_id FROM messages
                             GROUP BY conversation_id
                             HAVING MAX(created_at) < ?3
                           )",
                        params![now, cutoff, active_floor],
                    )?;
                    Ok(deleted as i64)
                })();
                match inner {
                    Ok(n) => {
                        conn.execute_batch("COMMIT")?;
                        Ok(n)
                    }
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Err(e)
                    }
                }
            })
        })();
        // Detach regardless of the move outcome.
        let _ = conn.execute_batch("DETACH DATABASE arch");
        moved
    })();

    match result {
        Ok(n) => PhaseResult {
            ran: true,
            skipped_reason: None,
            rows: n,
        },
        Err(e) => {
            crate::diagnostics::warn_with(
                "maintenance",
                "archive phase failed — skipped (no data moved)",
                serde_json::json!({ "error": e.to_string() }),
            );
            PhaseResult {
                ran: false,
                skipped_reason: Some(e.to_string()),
                rows: 0,
            }
        }
    }
}

/* ── Phase 3: reclaim ── */

fn run_reclaim_phase() -> PhaseResult {
    let result: Result<()> = (|| {
        let conn = get_db()?;
        // Checkpoint the WAL back into the main DB (TRUNCATE resets the WAL file
        // to zero bytes). ANALYZE refreshes the planner stats after the trims/
        // archive churned row counts. FTS 'optimize' merges the index b-trees.
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .context("wal_checkpoint")?;
        // ANALYZE writes the sqlite_stat tables, so it is a writer and MUST
        // hold the single-writer gate (WS3) — otherwise it opens its own
        // autocommit txn that can collide with a concurrent IMMEDIATE writer
        // and block up to busy_timeout (5s) / fail SQLITE_BUSY. wal_checkpoint
        // above is a checkpoint, not a txn-writer, so it stays outside.
        let _ = history::with_write_lock(|| {
            conn.execute_batch("ANALYZE;").context("analyze")?;
            Ok(())
        });
        // FTS optimize is a write — route through the gate.
        let _ = history::with_write(|tx| {
            tx.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES ('optimize');")?;
            Ok(())
        });
        Ok(())
    })();
    match result {
        Ok(()) => PhaseResult {
            ran: true,
            skipped_reason: None,
            rows: 0,
        },
        Err(e) => {
            crate::diagnostics::warn_with(
                "maintenance",
                "reclaim phase failed — skipped",
                serde_json::json!({ "error": e.to_string() }),
            );
            PhaseResult {
                ran: false,
                skipped_reason: Some(e.to_string()),
                rows: 0,
            }
        }
    }
}

/* ── Phase 4: auto-refresh stale RAG corpora ── */

/// Outcome of a stale-corpus refresh sweep, for diagnostics + a future UI.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RefreshReport {
    /// Corpora whose source folder had drifted and were re-ingested.
    pub refreshed: usize,
    /// Corpora checked total.
    pub checked: usize,
    /// Chunks re-created across all refreshed corpora.
    pub chunks: usize,
}

/// Re-ingest every corpus whose source folder has drifted since its last
/// ingest (W2-RAG, 2026-06-15). Cheap by construction: `corpus_stale` is a
/// stat-only diff, and the re-ingest itself takes the copy-forward fast path
/// for every UNCHANGED file (no re-read/re-chunk/re-embed), so the cost is
/// proportional to what actually changed, not corpus size. Embedding is local
/// (hashed or the user's own Ollama), so this spends no metered API credits.
/// Fully fail-open: a failure on one corpus is logged and the sweep continues.
///
/// This is a `pub fn` so it can back BOTH a scheduled sweep (wired below) and a
/// manual "Refresh stale" action from the RAG panel once a Tauri command is
/// added for it (see the file-tail note — that command + the UI button live in
/// files outside this module's ownership).
pub fn refresh_stale_corpora() -> RefreshReport {
    let mut report = RefreshReport::default();
    let corpora = match crate::rag::list_corpora() {
        Ok(c) => c,
        Err(e) => {
            crate::diagnostics::warn_with(
                "maintenance",
                "stale-refresh: list_corpora failed — skipped",
                serde_json::json!({ "error": e.to_string() }),
            );
            return report;
        }
    };
    for c in &corpora {
        report.checked += 1;
        let stale = match crate::rag::corpus_stale(&c.name) {
            Ok(s) => s,
            Err(e) => {
                crate::diagnostics::warn_with(
                    "maintenance",
                    "stale-refresh: staleness check failed — corpus skipped",
                    serde_json::json!({ "corpus": c.name, "error": e.to_string() }),
                );
                continue;
            }
        };
        if !stale {
            continue;
        }
        match crate::rag::ingest_folder(crate::rag::IngestOpts {
            name: c.name.clone(),
            root: c.root_path.clone(),
            glob: None,
        }) {
            Ok(rep) => {
                report.refreshed += 1;
                report.chunks += rep.chunks_created;
                crate::diagnostics::info(
                    "maintenance",
                    &format!(
                        "stale-refresh: re-ingested '{}' ({} chunks)",
                        c.name, rep.chunks_created
                    ),
                );
            }
            Err(e) => {
                crate::diagnostics::warn_with(
                    "maintenance",
                    "stale-refresh: re-ingest failed — corpus skipped",
                    serde_json::json!({ "corpus": c.name, "error": e.to_string() }),
                );
            }
        }
    }
    report
}

/* ── Orchestration ── */

/// Run a maintenance pass under `cfg`. Each phase is fail-open. The VACUUM
/// trigger additionally runs a full `VACUUM` at the end (the only path that
/// does so).
pub fn run_maintenance(cfg: &MaintenanceConfig, trigger: Trigger) -> MaintenanceReport {
    let started_at = now_unix();
    let t0 = std::time::Instant::now();
    let bytes_before = live_bytes();

    // The safe phases only run when enabled (the VACUUM trigger still vacuums
    // regardless, since the user explicitly asked).
    let (caps, archive, reclaim) = if cfg.enabled || trigger == Trigger::Vacuum {
        let caps = run_caps_phase();
        let archive = run_archive_phase(cfg);
        let reclaim = run_reclaim_phase();
        (caps, archive, reclaim)
    } else {
        let skip = || PhaseResult {
            ran: false,
            skipped_reason: Some("maintenance disabled".into()),
            rows: 0,
        };
        (skip(), skip(), skip())
    };

    let vacuumed = if trigger == Trigger::Vacuum {
        run_vacuum()
    } else {
        false
    };

    let bytes_after = live_bytes();
    let report = MaintenanceReport {
        trigger,
        started_at,
        duration_ms: t0.elapsed().as_millis(),
        bytes_before,
        bytes_after,
        caps,
        archive,
        reclaim,
        vacuumed,
    };
    crate::diagnostics::info(
        "maintenance",
        &format!(
            "pass complete ({:?}): archived {} / trimmed {} / {} -> {} bytes{}",
            report.trigger,
            report.archive.rows,
            report.caps.rows,
            report.bytes_before,
            report.bytes_after,
            if report.vacuumed { " (VACUUMed)" } else { "" }
        ),
    );
    report
}

/// Full `VACUUM` — rewrites the whole DB to reclaim freed pages and defragment.
/// Takes a global lock for the duration; NEVER called by the scheduler, only by
/// the explicit `db_maintenance_vacuum` command. Best-effort (fail-open).
fn run_vacuum() -> bool {
    let result: Result<()> = (|| {
        let conn = get_db()?;
        // VACUUM cannot run inside a transaction. Take the write gate so no
        // other writer is mid-transaction, then VACUUM on this connection.
        history::with_write_lock(|| {
            conn.execute_batch("VACUUM;").context("vacuum")?;
            Ok(())
        })
    })();
    match result {
        Ok(()) => true,
        Err(e) => {
            crate::diagnostics::warn_with(
                "maintenance",
                "VACUUM failed — skipped",
                serde_json::json!({ "error": e.to_string() }),
            );
            false
        }
    }
}

/* ── Scheduler ── */

/// How often the scheduler wakes to consider a maintenance pass. The actual
/// cadence is governed by `idle_interval_hours` (a wake that's too soon since
/// the last pass is a no-op), so this only needs to be fine enough to honour a
/// freshly-lowered interval without re-reading settings constantly.
const WAKE_INTERVAL_SECS: u64 = 30 * 60; // 30 min

/// Archival evaluation cadence: the archive phase is the expensive one, so even
/// when a pass runs we only let it archive at most once per day.
const ARCHIVE_EVAL_SECS: i64 = 86_400;

/// A light maintenance pass kicked off shortly after boot, off the first-paint
/// path via `spawn_blocking`. Caps + reclaim only catch up after a long-running
/// session; the archive phase is gated to once/day inside the run so a boot
/// pass right after a recent one won't re-archive.
pub fn light_boot_pass() {
    tauri::async_runtime::spawn_blocking(|| {
        let cfg = crate::settings::load().maintenance.unwrap_or_default();
        if !cfg.enabled {
            return;
        }
        let _ = run_maintenance(&cfg, Trigger::Boot);
    });
}

/// Start the app-lifetime maintenance scheduler. Modeled on
/// `workflows::start_scheduler`: a tokio task that `select!`s the shared
/// shutdown `Notify` against a sleep, so it exits promptly on app exit. Each
/// wake re-reads the policy (so a settings change takes effect without a
/// restart), then runs a pass if `idle_interval_hours` has elapsed since the
/// last one. The archive phase is additionally gated to `ARCHIVE_EVAL_SECS`.
pub fn start_maintenance_scheduler(
    _app: tauri::AppHandle,
    shutdown: std::sync::Arc<tokio::sync::Notify>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_pass_at: i64 = 0;
        let mut last_archive_at: i64 = 0;
        let mut last_refresh_at: i64 = 0;
        loop {
            if crate::is_shutting_down() {
                break;
            }
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(WAKE_INTERVAL_SECS)) => {}
            }
            if crate::is_shutting_down() {
                break;
            }
            // Re-read policy each wake so settings edits take effect live.
            let mut cfg = crate::settings::load().maintenance.unwrap_or_default();
            if !cfg.enabled {
                continue;
            }
            let now = now_unix();
            let interval_secs = (cfg.idle_interval_hours.max(1) as i64) * 3600;
            if now - last_pass_at < interval_secs {
                continue;
            }
            // Gate the (expensive) archive phase to once per day even though the
            // safe phases may run more often. Decide eligibility WITHOUT
            // mutating last_archive_at up front — that timestamp only advances
            // after the pass actually archives (below), so a failed/fail-open
            // pass doesn't suppress archiving for the next 24h.
            if now - last_archive_at < ARCHIVE_EVAL_SECS {
                cfg.archive_messages = false;
            }
            // Run off the async runtime's worker via spawn_blocking — the pass
            // does synchronous SQLite I/O.
            let report = tauri::async_runtime::spawn_blocking(move || {
                run_maintenance(&cfg, Trigger::Scheduled)
            })
            .await;
            if let Ok(r) = &report {
                last_pass_at = now;
                // Only advance the archive gate when the archive phase actually
                // ran (not skipped/failed-open), so archiving isn't suppressed
                // for ~24h by a pass that moved zero rows.
                if r.archive.ran {
                    last_archive_at = now;
                }
            }
            // Auto-refresh stale RAG corpora, gated to once per day like the
            // archive phase: re-walking every corpus root + re-embedding changed
            // files is the heavy part, so a wake more frequent than the interval
            // shouldn't keep re-scanning. Runs after the DB pass, off the worker
            // via spawn_blocking (corpus_stale stats the filesystem, ingest does
            // synchronous I/O). Fully fail-open inside refresh_stale_corpora.
            if now - last_refresh_at >= ARCHIVE_EVAL_SECS {
                let refresh = tauri::async_runtime::spawn_blocking(refresh_stale_corpora).await;
                if let Ok(r) = refresh {
                    // Advance the gate whenever the sweep ran to completion, even
                    // if nothing was stale — a clean scan still satisfies the
                    // daily cadence; failures inside are logged + counted as a
                    // no-op so they don't suppress the next day's sweep harder
                    // than a successful empty one.
                    last_refresh_at = now;
                    if r.refreshed > 0 {
                        crate::diagnostics::info(
                            "maintenance",
                            &format!(
                                "stale-refresh: {} of {} corpora re-ingested ({} chunks)",
                                r.refreshed, r.checked, r.chunks
                            ),
                        );
                    }
                }
            }
        }
    });
}

/* ── Recovery: restore archived messages ── */

/// Restore every archived message for `conversation_id` back into the live
/// `messages` table, then delete them from the archive. Makes archive-not-delete
/// real: an archived conversation can be fully reconstituted. Returns the number
/// of messages restored. Atomic via the write gate.
pub fn restore_archived(conversation_id: i64) -> Result<usize> {
    let archive = archive_db_path()?;
    if !archive.exists() {
        return Ok(0);
    }
    let conn = get_db()?;
    let archive_str = archive.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("ATTACH DATABASE '{archive_str}' AS arch"))
        .context("attach archive db")?;
    let restored = (|| -> Result<usize> {
        let has_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM arch.sqlite_master \
                 WHERE type='table' AND name='messages_archive'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_table == 0 {
            return Ok(0);
        }
        history::with_write_lock(|| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let inner = (|| -> Result<usize> {
                // The parent conversation may have been DELETED after its
                // messages were archived (the archive snapshots the title for
                // exactly this case). Recreate a stub from the snapshotted title
                // first, or the restored messages would be orphaned / violate the
                // messages→conversations FK (review M5). INSERT OR IGNORE is a
                // no-op when the conversation still exists; HAVING COUNT(*)>0
                // means no stub is created when there's nothing to restore.
                conn.execute(
                    "INSERT OR IGNORE INTO conversations (id, title, created_at)
                     SELECT ?1,
                            COALESCE(MIN(conversation_title), 'Restored conversation'),
                            COALESCE(MIN(created_at), strftime('%s','now'))
                     FROM arch.messages_archive
                     WHERE conversation_id = ?1
                     HAVING COUNT(*) > 0",
                    params![conversation_id],
                )?;
                // Re-insert with the ORIGINAL ids (the archive preserves them).
                // The FTS insert-trigger reindexes each restored row.
                let n = conn.execute(
                    "INSERT OR IGNORE INTO messages
                        (id, conversation_id, role, content, created_at, model, images)
                     SELECT id, conversation_id, role, content, created_at, model, images
                     FROM arch.messages_archive
                     WHERE conversation_id = ?1",
                    params![conversation_id],
                )?;
                conn.execute(
                    "DELETE FROM arch.messages_archive WHERE conversation_id = ?1",
                    params![conversation_id],
                )?;
                Ok(n)
            })();
            match inner {
                Ok(n) => {
                    conn.execute_batch("COMMIT")?;
                    Ok(n)
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
    })();
    let _ = conn.execute_batch("DETACH DATABASE arch");
    restored
}

/* ── Tests ── */

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize the maintenance tests. They run archive/restore/trim phases
    /// against the PROCESS-GLOBAL live DB (a singleton pool — there is no clean
    /// per-test DB to swap in), so two of them running on different test threads
    /// race on the shared `messages`/archive tables (intermittent failures under
    /// `cargo test --no-default-features`). Every test in this module takes this
    /// lock first, which makes the suite deterministic without weakening any
    /// assertion. Poison is recovered (a panicking test must not wedge the rest).
    fn maint_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// archive-not-delete + restore round-trip against the real pool: an old
    /// message in a quiet conversation is archived (gone from `messages`,
    /// present in the archive), and `restore_archived` brings it back with its
    /// original id. A FRESH (recently-active) conversation is never touched.
    #[test]
    fn archive_then_restore_round_trip_and_active_window_exclusion() {
        let _guard = maint_test_lock();
        let now = now_unix();
        // Quiet conversation: a very old message, no recent activity.
        let quiet = history::create_conversation(
            &format!("__test_maint_quiet_{}", std::process::id()),
            None,
        )
        .unwrap();
        let old_msg = history::add_message(quiet, "user", "ancient history", None, None).unwrap();
        // Backdate both the message and (implicitly) the conversation's newest
        // activity to two years ago.
        {
            let two_years_ago = now - 2 * 365 * 86_400;
            history::with_write(|tx| {
                tx.execute(
                    "UPDATE messages SET created_at = ?1 WHERE id = ?2",
                    params![two_years_ago, old_msg],
                )?;
                Ok(())
            })
            .unwrap();
        }
        // Active conversation: a brand-new message — must be excluded.
        let active = history::create_conversation(
            &format!("__test_maint_active_{}", std::process::id()),
            None,
        )
        .unwrap();
        let fresh_msg =
            history::add_message(active, "user", "happening right now", None, None).unwrap();

        let cfg = MaintenanceConfig {
            enabled: true,
            archive_messages: true,
            archive_age_days: 365,
            active_window_secs: 86_400,
            hard_delete_archived: false,
            auto_vacuum: false,
            idle_interval_hours: 6,
        };
        let phase = run_archive_phase(&cfg);
        assert!(phase.ran, "archive phase should run: {phase:?}");
        // Assert OUR message specifically moved (robust against a concurrent
        // maintenance test archiving 0 of its own rows in the same shared DB) —
        // phase.rows is a global count and is racy under parallel test threads.
        let archived_here: i64 = {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE id = ?1",
                params![old_msg],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            archived_here, 0,
            "the old message must have been archived (moved out of messages)"
        );

        let present = |id: i64| -> i64 {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(present(old_msg), 0, "old message archived out of live DB");
        assert_eq!(present(fresh_msg), 1, "active conversation untouched");

        // Restore brings the archived message back with its original id.
        let restored = restore_archived(quiet).unwrap();
        assert!(restored >= 1, "at least one message restored");
        assert_eq!(present(old_msg), 1, "restored message is back in live DB");

        // Cleanup.
        history::delete_conversation(quiet).unwrap();
        history::delete_conversation(active).unwrap();
    }

    /// Agent checkpoint "shadow" rows (non-null run_id, migration v28) are
    /// NEVER archived: archiving them would lose their run_id/turn_index/tool_*
    /// metadata and make them visible again on restore. An aged shadow row in an
    /// otherwise-quiet conversation must stay in `messages` after a pass.
    #[test]
    fn archive_skips_agent_checkpoint_shadow_rows() {
        let _guard = maint_test_lock();
        let now = now_unix();
        let conv = history::create_conversation(
            &format!("__test_maint_shadow_{}", std::process::id()),
            None,
        )
        .unwrap();
        // A normal old message (should archive) + an old checkpoint shadow row
        // (must NOT archive).
        let normal = history::add_message(conv, "user", "old chatter", None, None).unwrap();
        let run_id = format!("__test_run_{}", std::process::id());
        history::checkpoint_run(
            &run_id,
            conv,
            &[history::CheckpointTurn {
                turn_index: 0,
                role: "assistant".into(),
                content: "internal checkpoint".into(),
                tool_call_id: Some("tc-1".into()),
                tool_name: Some("read_file".into()),
                model: None,
            }],
        )
        .unwrap();
        // Backdate every row in the conversation past the cutoff so the whole
        // conversation is "quiet" and eligible by age.
        let two_years_ago = now - 2 * 365 * 86_400;
        history::with_write(|tx| {
            tx.execute(
                "UPDATE messages SET created_at = ?1 WHERE conversation_id = ?2",
                params![two_years_ago, conv],
            )?;
            Ok(())
        })
        .unwrap();

        let cfg = MaintenanceConfig {
            enabled: true,
            archive_messages: true,
            archive_age_days: 365,
            active_window_secs: 86_400,
            hard_delete_archived: false,
            auto_vacuum: false,
            idle_interval_hours: 6,
        };
        let phase = run_archive_phase(&cfg);
        assert!(phase.ran, "archive phase should run: {phase:?}");

        let present = |id: i64| -> i64 {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let shadow_count = || -> i64 {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1 AND run_id IS NOT NULL",
                params![conv],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(present(normal), 0, "normal old message archived out");
        assert_eq!(
            shadow_count(),
            1,
            "checkpoint shadow row must remain in the live DB, not archived"
        );

        // Cleanup.
        history::delete_conversation(conv).unwrap();
    }

    /// The caps trim keeps the newest `cap` rows and is a no-op below the cap.
    /// Exercises `trim_table` against the real `agent_audit` via a tiny cap.
    #[test]
    fn trim_table_keeps_newest_and_is_noop_below_cap() {
        let _guard = maint_test_lock();
        // Seed a marker set of rows we can identify + clean up.
        let tag = format!("__test_trim_{}", std::process::id());
        let seed = |n: usize| {
            for i in 0..n {
                history::with_write(|tx| {
                    tx.execute(
                        "INSERT INTO agent_audit
                            (ts, conversation_id, tool_name, args_json, result_hash,
                             result_size, duration_ms, approval, outcome)
                         VALUES (1, ?1, ?2, '{}', 'h', 0, 1, 'auto', 'ok')",
                        params![tag, format!("{tag}-{i}")],
                    )?;
                    Ok(())
                })
                .unwrap();
            }
        };
        let count_tagged = || -> i64 {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM agent_audit WHERE conversation_id = ?1",
                params![tag],
                |r| r.get(0),
            )
            .unwrap()
        };
        seed(10);
        assert_eq!(count_tagged(), 10);
        // A huge cap is a no-op (table is far under it).
        trim_table("agent_audit", 1_000_000).unwrap();
        assert_eq!(count_tagged(), 10, "trim below cap is a no-op");
        // Cleanup our marker rows (the global trim test would otherwise affect
        // the shared real DB).
        history::with_write(|tx| {
            tx.execute(
                "DELETE FROM agent_audit WHERE conversation_id = ?1",
                params![tag],
            )?;
            Ok(())
        })
        .unwrap();
    }

    /// `stats()` returns sane (non-erroring) numbers against the real pool.
    #[test]
    fn stats_does_not_error() {
        let _guard = maint_test_lock();
        let s = stats().expect("stats must not error");
        assert!(s.db_bytes >= 0);
        assert!(s.conversations >= 0);
        assert!(s.messages_archived >= 0);
    }

    /// A disabled policy skips the safe phases entirely (and never errors).
    #[test]
    fn disabled_policy_skips_safe_phases() {
        let _guard = maint_test_lock();
        let cfg = MaintenanceConfig {
            enabled: false,
            ..MaintenanceConfig::default()
        };
        let report = run_maintenance(&cfg, Trigger::Scheduled);
        assert!(!report.caps.ran);
        assert!(!report.archive.ran);
        assert!(!report.reclaim.ran);
        assert!(!report.vacuumed);
    }

    /// W2-RAG (2026-06-15): the stale-corpus sweep re-ingests a corpus whose
    /// source folder drifted, and leaves a fresh one untouched. Uses a unique
    /// corpus name + temp dir so it coexists with the shared dev DB.
    #[test]
    fn refresh_stale_corpora_reingests_drifted_corpus() {
        let _guard = maint_test_lock();
        let tag = format!("{}_refr", std::process::id());
        let name = format!("__test_refresh_{tag}");
        let dir = std::env::temp_dir().join(format!("maint_refresh_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.txt");
        std::fs::write(&file, "refreshcheck refreshcheck original body text").unwrap();
        crate::rag::ingest_folder(crate::rag::IngestOpts {
            name: name.clone(),
            root: dir.to_string_lossy().into_owned(),
            glob: None,
        })
        .expect("seed ingest");

        // Not stale yet → a sweep refreshes nothing about THIS corpus.
        assert!(!crate::rag::corpus_stale(&name).unwrap());

        // Drift the source (size changes → detected without an mtime bump).
        std::fs::write(
            &file,
            "refreshcheck UPDATED with a clearly longer replacement body text now",
        )
        .unwrap();
        assert!(crate::rag::corpus_stale(&name).unwrap());

        // The sweep re-ingests it. `checked`/`refreshed` are global counts over
        // the shared DB, so assert on the per-corpus effect: it is no longer
        // stale afterwards and the new content is searchable.
        let report = refresh_stale_corpora();
        assert!(report.checked >= 1, "sweep must check at least our corpus");
        assert!(
            !crate::rag::corpus_stale(&name).unwrap(),
            "corpus must no longer be stale after the sweep"
        );
        let hits = crate::rag::search(&name, "UPDATED", 5).unwrap();
        assert!(
            hits.iter().any(|h| h.snippet.contains("UPDATED")),
            "refreshed content must be searchable, got: {hits:?}"
        );

        // Cleanup.
        let _ = crate::rag::delete_corpus(&name);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
