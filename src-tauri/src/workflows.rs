//! Workflows (agent orchestration) persistence + scheduling.
//!
//! A workflow's graph is a JSON object `{ "cards": Card[], "edges": Edge[] }`.
//! The graph_json string is owned by the frontend; the backend validates only
//! its shape (so the column never holds unparseable garbage) and treats card
//! `schedule` strings as opaque — except the scheduler, which parses a couple
//! of tolerant formats to decide when to emit a `workflow-trigger` event.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::history::{get_db, now_unix};

/// Hard cap on the JSON-encoded workflow graph. Generous for a canvas of
/// agent cards, but bounded so a malformed IPC call can't balloon the row.
pub const MAX_GRAPH_BYTES: usize = 1_048_576; // 1 MiB

#[derive(Serialize, Clone)]
pub struct Workflow {
    pub id: i64,
    pub name: String,
    /// Raw `{ cards, edges }` JSON string — the frontend `JSON.parse`s this.
    pub graph_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
pub struct WorkflowRun {
    pub id: i64,
    pub workflow_id: i64,
    pub started_at: i64,
    pub status: String,
    /// Raw JSON string of per-run results, or `None`.
    pub results_json: Option<String>,
}

/// Idempotently create the `workflows` and `workflow_runs` tables. Called from
/// the migration ladder; safe to re-run against a schema that already has them.
pub(crate) fn ensure_workflow_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            graph_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workflow_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            results_json TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id);
         CREATE TABLE IF NOT EXISTS workflow_card_fired (
            card_key TEXT PRIMARY KEY,
            last_fired INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

/// Idempotently add `workflow_id` to `workflow_card_fired` and backfill it.
///
/// Why: the original delete path used `card_key LIKE '<id>:%'`, which matched
/// any key starting with that digit run plus a colon — for `id=1`, a row keyed
/// `10:foo` would not match (`1:%` requires a literal `:` immediately after
/// `1`), but for `id=10` the pattern `10:%` correctly matches only `10:…` —
/// the *real* danger lived in any future use that dropped the colon, and in
/// the general fragility of pattern-matching identifiers. Storing an integer
/// column lets `delete_workflow` use equality, which can never over-match.
///
/// Backfill: parse the leading run of digits before the first `:` out of each
/// existing card_key (the historical format is `"<workflow_id>:<card_id>"`).
/// Rows whose key doesn't fit the pattern are left with `workflow_id = NULL`
/// and will be cleaned up by the next scheduler scan via `prune_card_last_fired`.
pub(crate) fn ensure_card_fired_workflow_id_column(conn: &Connection) -> Result<()> {
    // Re-run table creation first. Some users hit v8 BEFORE
    // `workflow_card_fired` was added to `ensure_workflow_tables`, so their
    // user_version is 8 but the table is absent — the ALTER below would
    // explode on them. `ensure_workflow_tables` uses CREATE TABLE IF NOT
    // EXISTS, so this is a free no-op on every healthy DB.
    ensure_workflow_tables(conn)?;
    let has: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('workflow_card_fired') WHERE name = 'workflow_id'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("pragma_table_info failed: {e}")),
    };
    if !has {
        conn.execute(
            "ALTER TABLE workflow_card_fired ADD COLUMN workflow_id INTEGER",
            [],
        )?;
    }
    // Backfill any rows still missing a workflow_id. Re-running this step is
    // a cheap no-op on a populated table because the WHERE filters them out.
    let mut select =
        conn.prepare("SELECT card_key FROM workflow_card_fired WHERE workflow_id IS NULL")?;
    let keys: Vec<String> = select
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(select);
    for k in keys {
        if let Some(wid) = parse_workflow_id_prefix(&k) {
            conn.execute(
                "UPDATE workflow_card_fired SET workflow_id = ?1 WHERE card_key = ?2",
                params![wid, k],
            )?;
        }
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_workflow_card_fired_wf
         ON workflow_card_fired(workflow_id)",
        [],
    )?;
    Ok(())
}

/// Parse the leading run of digits before the first `:` out of a card_key.
/// Returns `None` if the key has no `:` or the prefix is not a positive
/// integer. Used by the v9 migration backfill.
fn parse_workflow_id_prefix(key: &str) -> Option<i64> {
    let (head, _) = key.split_once(':')?;
    head.parse::<i64>().ok()
}

/// Load the persisted last-fired map: `"<workflow_id>:<card_id>"` → unix secs.
/// Survives app restarts so a `daily HH:MM` card fires at most once per day
/// even across relaunches (an in-memory-only map re-fires every cold start).
pub fn load_card_last_fired() -> Result<std::collections::HashMap<String, i64>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare("SELECT card_key, last_fired FROM workflow_card_fired")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?;
    Ok(rows)
}

/// Persist a batch of `(card_key, workflow_id, last_fired)` upserts in ONE
/// IMMEDIATE transaction. A scheduler tick can seed/fire many cards; doing a
/// separate connection-checkout + upsert per card on the hot path multiplied
/// pool pressure and fsyncs. Batching collapses a tick's writes into a single
/// transaction. `Immediate` matches `record_run`/`delete_workflow` so the write
/// can't fail on lock-promotion under the concurrent perf-ledger writer.
///
/// `workflow_id` is stored in a dedicated integer column so `delete_workflow`
/// can delete by equality — see `ensure_card_fired_workflow_id_column`.
pub fn persist_card_last_fired_batch(rows: &[(String, i64, i64)]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // WS3: single-writer gate. The whole batch upsert is one serialized txn.
    crate::history::with_write(|tx| {
        let mut stmt = tx.prepare(
            "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(card_key) DO UPDATE SET
                workflow_id = excluded.workflow_id,
                last_fired = excluded.last_fired",
        )?;
        for (card_key, workflow_id, ts) in rows {
            stmt.execute(params![card_key, workflow_id, ts])?;
        }
        Ok(())
    })
}

/// Persist a tick's batched card fire/seed times and, on failure, emit a
/// diagnostics warning instead of silently dropping the error. A swallowed
/// persist (e.g. pool exhaustion) leaves the fires recorded only in memory: the
/// cards won't re-fire this process, but after a restart the disk lacks the
/// record and a `daily HH:MM` card can multi-fire within the same day. We can't
/// guarantee the write succeeds, but we make its failure visible. The batch
/// mixes "seed" and "fire" rows, so the log reports the count rather than a
/// single phase.
fn warn_if_persist_batch_failed(rows: &[(String, i64, i64)]) {
    if let Err(e) = persist_card_last_fired_batch(rows) {
        crate::diagnostics::warn_with(
            "workflow",
            "failed to persist scheduler card fire times — may re-fire after restart",
            serde_json::json!({
                "rows": rows.len(),
                "error": e.to_string(),
            }),
        );
    }
}

/// Drop persisted last-fired rows whose card_key is not in `keep` — keeps the
/// table from growing as workflows/cards are edited or deleted.
///
/// Perf (review 2026-06-13): instead of reading the whole table into a Vec and
/// issuing one auto-committed DELETE per stale key (a full-table SELECT + N
/// implicit transactions/fsyncs, with zero rows actually deleted in the common
/// steady state), let SQLite do the filtering with a single set-based DELETE.
/// rusqlite is built with only `["bundled","backup"]` here — no `array`/carray
/// feature — so the keep set is bound via a dynamic `IN (?, ?, …)` placeholder
/// list rather than `rarray(?1)`. One statement, one implicit transaction, no
/// SELECT and no per-key Vec allocation.
pub fn prune_card_last_fired(keep: &std::collections::HashSet<String>) -> Result<()> {
    // WS3: single-writer gate.
    crate::history::with_write(|tx| {
        if keep.is_empty() {
            // `NOT IN ()` is not valid SQL — an empty keep set means "drop all".
            tx.execute("DELETE FROM workflow_card_fired", [])?;
            return Ok(());
        }
        // Build `?,?,…` once, then bind each kept key positionally.
        let placeholders = std::iter::repeat_n("?", keep.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("DELETE FROM workflow_card_fired WHERE card_key NOT IN ({placeholders})");
        let params: Vec<&dyn rusqlite::ToSql> =
            keep.iter().map(|k| k as &dyn rusqlite::ToSql).collect();
        tx.execute(&sql, params.as_slice())?;
        Ok(())
    })
}

/// Validate that `graph_json` parses as a JSON object of the shared shape:
/// `{ "cards": Card[], "edges": Edge[] }`. Each card must carry the required
/// keys with the right primitive types; each edge needs string `from`/`to`.
/// Returns a clear error on any deviation so the column never holds garbage.
pub fn validate_graph_json(graph_json: &str) -> Result<()> {
    // Bound the input before parsing. The graph is authored by the renderer,
    // but a compromised renderer (our threat model) could POST a multi-MB blob
    // to bloat the DB row + every run's context. Reuse the shared 1 MiB ceiling
    // (same one `record_run` enforces on results_json) — far above any real
    // graph (hundreds of cards). Sec audit (2026-06).
    if graph_json.len() > MAX_GRAPH_BYTES {
        return Err(anyhow::anyhow!(
            "graph_json too large ({} bytes; max {MAX_GRAPH_BYTES})",
            graph_json.len()
        ));
    }
    let value: serde_json::Value = serde_json::from_str(graph_json)
        .map_err(|e| anyhow::anyhow!("graph_json is not valid JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("graph_json must be a JSON object"))?;

    let cards = obj
        .get("cards")
        .ok_or_else(|| anyhow::anyhow!("graph_json missing 'cards'"))?
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("'cards' must be an array"))?;
    let edges = obj
        .get("edges")
        .ok_or_else(|| anyhow::anyhow!("graph_json missing 'edges'"))?
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("'edges' must be an array"))?;

    for (i, card) in cards.iter().enumerate() {
        let c = card
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("card {i} must be an object"))?;
        for key in ["id", "name", "preset", "prompt"] {
            match c.get(key) {
                Some(v) if v.is_string() => {}
                _ => return Err(anyhow::anyhow!("card {i} field '{key}' must be a string")),
            }
        }
        match c.get("tools") {
            Some(v)
                if v.as_array()
                    .is_some_and(|a| a.iter().all(|t| t.is_string())) => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "card {i} field 'tools' must be a string array"
                ))
            }
        }
        for key in ["schedule", "backend"] {
            match c.get(key) {
                Some(v) if v.is_string() || v.is_null() => {}
                _ => {
                    return Err(anyhow::anyhow!(
                        "card {i} field '{key}' must be a string or null"
                    ))
                }
            }
        }
        for key in ["x", "y"] {
            match c.get(key) {
                Some(v) if v.is_number() => {}
                _ => return Err(anyhow::anyhow!("card {i} field '{key}' must be a number")),
            }
        }
        // Optional per-card opt-in: cards may carry `unattended: bool`. Absent
        // is fine; if present it must be a boolean (not a string/number).
        match c.get("unattended") {
            None => {}
            Some(v) if v.is_boolean() => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "card {i} field 'unattended' must be a boolean"
                ))
            }
        }
        // Optional per-card model pin: `model: string | null`. Absent or null
        // means fall back to the backend's current model.
        match c.get("model") {
            None => {}
            Some(v) if v.is_string() || v.is_null() => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "card {i} field 'model' must be a string or null"
                ))
            }
        }
        // Optional placement flag: `placed: bool`. Absent/false = the card sits
        // in the deck; true = placed on the canvas at its x/y.
        match c.get("placed") {
            None => {}
            Some(v) if v.is_boolean() => {}
            _ => return Err(anyhow::anyhow!("card {i} field 'placed' must be a boolean")),
        }
        // Optional per-card system-prompt override: `systemPrompt: string | null`.
        // When non-empty, the runner uses this instead of the role/preset's
        // systemPromptOverride for that card only. The frontend normalizer
        // (`normalizeWorkflowCard`) hard-caps the string at 16 KiB; we mirror
        // a much-looser cap here so a malformed IPC can't push hundreds of KiB
        // of system-prompt into the graph_json and bloat every run's context.
        match c.get("systemPrompt") {
            None => {}
            Some(v) if v.is_null() => {}
            Some(v) if v.is_string() => {
                let len = v.as_str().map(|s| s.len()).unwrap_or(0);
                // Hard cap mirrors `SYSTEM_PROMPT_MAX` on the JS side, plus a
                // little headroom for the JSON-encoded form. Reject anything
                // wildly larger — the frontend would have already truncated.
                if len > 32_768 {
                    return Err(anyhow::anyhow!(
                        "card {i} field 'systemPrompt' exceeds 32 KiB ({len} bytes)"
                    ));
                }
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "card {i} field 'systemPrompt' must be a string or null"
                ))
            }
        }
        // Optional accent color: `color: string | null`. A short hex from
        // the curated frontend palette. We don't enforce the exact palette
        // server-side (cosmetic + may grow); only that it's a bounded
        // string so graph_json can't be stuffed with a giant value. The
        // frontend normalizer rejects anything off-palette. (2026-05-28)
        match c.get("color") {
            None => {}
            Some(v) if v.is_null() => {}
            Some(v) if v.is_string() => {
                let len = v.as_str().map(|s| s.len()).unwrap_or(0);
                if len > 64 {
                    return Err(anyhow::anyhow!(
                        "card {i} field 'color' exceeds 64 bytes ({len})"
                    ));
                }
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "card {i} field 'color' must be a string or null"
                ))
            }
        }
    }

    for (i, edge) in edges.iter().enumerate() {
        let e = edge
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("edge {i} must be an object"))?;
        for key in ["from", "to"] {
            match e.get(key) {
                Some(v) if v.is_string() => {}
                _ => return Err(anyhow::anyhow!("edge {i} field '{key}' must be a string")),
            }
        }
    }
    Ok(())
}

fn row_to_workflow(r: &rusqlite::Row<'_>) -> rusqlite::Result<Workflow> {
    Ok(Workflow {
        id: r.get(0)?,
        name: r.get(1)?,
        graph_json: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

pub fn list_workflows() -> Result<Vec<Workflow>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, graph_json, created_at, updated_at
         FROM workflows ORDER BY updated_at DESC",
    )?;
    // Resilience: a single malformed row (e.g. a hand-seeded BLOB `graph_json`
    // or any column-type mismatch) must NOT empty the entire list. Collecting
    // into `Result<Vec<_>>` would turn one bad row into a total workflow
    // blackout AND wedge the scheduler scan that calls this every 30s. Skip the
    // unreadable row, log it, return the rest.
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        match row_to_workflow(r) {
            Ok(wf) => out.push(wf),
            Err(e) => crate::diagnostics::warn_with(
                "workflows",
                "skipping unreadable workflow row",
                serde_json::json!({ "error": e.to_string() }),
            ),
        }
    }
    Ok(out)
}

/// The scheduler's per-workflow cache key: id + `updated_at`. Deliberately
/// carries NO `graph_json` — the hot 30s scan only needs to know WHICH
/// workflows changed since last tick; the heavy blob is fetched (via
/// [`fetch_workflow_graph_json`]) ONLY for the rows whose cache entry missed.
/// In steady state (nothing edited) every row is a cache hit and not one blob
/// leaves SQLite, vs. the prior scan that re-read every full graph_json each
/// tick (perf review 2026-06-12).
pub(crate) struct WorkflowScheduleRow {
    pub id: i64,
    pub updated_at: i64,
}

/// List just (id, updated_at) for every workflow — two integers per row, no
/// blob. Per-row resilient like `list_workflows`: one unreadable row is skipped
/// + logged, never blanks the whole scan.
pub(crate) fn list_workflow_schedule_rows() -> Result<Vec<WorkflowScheduleRow>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare("SELECT id, updated_at FROM workflows ORDER BY updated_at DESC")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let parsed = (|| -> rusqlite::Result<WorkflowScheduleRow> {
            Ok(WorkflowScheduleRow {
                id: r.get(0)?,
                updated_at: r.get(1)?,
            })
        })();
        match parsed {
            Ok(row) => out.push(row),
            Err(e) => crate::diagnostics::warn_with(
                "workflows",
                "skipping unreadable workflow schedule row",
                serde_json::json!({ "error": e.to_string() }),
            ),
        }
    }
    Ok(out)
}

/// Fetch one workflow's `graph_json` blob — called only on a scheduler cache
/// miss (a workflow whose `updated_at` changed), so the cost scales with EDITS,
/// not with workflow count × tick rate.
fn fetch_workflow_graph_json(id: i64) -> Result<String> {
    let conn = get_db()?;
    conn.query_row(
        "SELECT graph_json FROM workflows WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .context("workflow graph_json not found")
}

pub fn get_workflow(id: i64) -> Result<Workflow> {
    let conn = get_db()?;
    conn.query_row(
        "SELECT id, name, graph_json, created_at, updated_at FROM workflows WHERE id = ?1",
        params![id],
        row_to_workflow,
    )
    .context("workflow not found")
}

/// Insert (when `id` is `None`) or update a workflow. `graph_json` is validated
/// before any write. Returns the workflow id.
pub fn save_workflow(id: Option<i64>, name: &str, graph_json: &str) -> Result<i64> {
    validate_graph_json(graph_json)?;
    let now = now_unix();
    // WS3: single-writer gate.
    crate::history::with_write(|tx| match id {
        None => {
            tx.execute(
                "INSERT INTO workflows (name, graph_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![name, graph_json, now],
            )?;
            Ok(tx.last_insert_rowid())
        }
        Some(existing) => {
            let changed = tx.execute(
                "UPDATE workflows SET name = ?1, graph_json = ?2, updated_at = ?3 WHERE id = ?4",
                params![name, graph_json, now, existing],
            )?;
            if changed == 0 {
                return Err(anyhow::anyhow!("workflow {existing} not found"));
            }
            Ok(existing)
        }
    })
}

pub fn delete_workflow(id: i64) -> Result<()> {
    // WS3: single-writer gate. All three deletes go in a single transaction so
    // a crash mid-delete can never leave orphan run rows or fire-tracking rows
    // pointing at a workflow that no longer exists. `workflow_card_fired`
    // carries a dedicated `workflow_id` integer column (v9 migration) so we
    // delete by equality — the prior `card_key LIKE '<id>:%'` approach was
    // fragile against any future prefix-collision and over-matched once
    // GLOB-style patterns were considered.
    crate::history::with_write(|tx| {
        tx.execute(
            "DELETE FROM workflow_runs WHERE workflow_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM workflow_card_fired WHERE workflow_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM workflows WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Number of historical runs kept per workflow. Anything older is pruned on
/// each insert. Set above `RUNS_LIMIT` (the read cap) so the recent-runs view
/// never starves, while keeping the table bounded — a scheduled card on a
/// 1-minute interval would otherwise add ~1440 rows/day forever. MED
/// (2026-05-29).
const RUNS_RETAIN: i64 = 250;

/// Record a workflow run. Returns the new run id. Prunes this workflow's runs
/// to the `RUNS_RETAIN` most recent in the same connection so the table stays
/// bounded under high-frequency scheduled triggers.
pub fn record_run(workflow_id: i64, status: &str, results_json: &str) -> Result<i64> {
    // Enforce the size cap HERE, not just at the IPC command boundary — the
    // scheduler calls `record_run` directly, so a cap only in commands/ would
    // let a scheduled run persist unbounded `results_json` and bloat every
    // `list_runs`. MAX_GRAPH_BYTES is the shared ceiling (commands reuse it).
    if results_json.len() > MAX_GRAPH_BYTES {
        anyhow::bail!(
            "results_json exceeds {MAX_GRAPH_BYTES} bytes ({} given)",
            results_json.len()
        );
    }
    // WS3: single-writer gate. Insert + retention-prune in ONE serialized txn
    // so the table can't be left in a half-pruned state if the second statement
    // fails (matches delete_workflow's transactional cleanup).
    crate::history::with_write(|tx| {
        tx.execute(
            "INSERT INTO workflow_runs (workflow_id, started_at, status, results_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![workflow_id, now_unix(), status, results_json],
        )?;
        let id = tx.last_insert_rowid();
        // Trim the oldest rows beyond the retention window for this workflow.
        tx.execute(
            "DELETE FROM workflow_runs
             WHERE workflow_id = ?1
               AND id NOT IN (
                   SELECT id FROM workflow_runs
                   WHERE workflow_id = ?1
                   ORDER BY started_at DESC, id DESC
                   LIMIT ?2
               )",
            params![workflow_id, RUNS_RETAIN],
        )?;
        Ok(id)
    })
}

/// Maximum number of recent runs returned per workflow.
const RUNS_LIMIT: i64 = 100;

pub fn list_runs(workflow_id: i64) -> Result<Vec<WorkflowRun>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, workflow_id, started_at, status, results_json
         FROM workflow_runs WHERE workflow_id = ?1
         ORDER BY started_at DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![workflow_id, RUNS_LIMIT], |r| {
            Ok(WorkflowRun {
                id: r.get(0)?,
                workflow_id: r.get(1)?,
                started_at: r.get(2)?,
                status: r.get(3)?,
                results_json: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/* ── Scheduler ── */

/// A parsed, tolerant interpretation of a card `schedule` string. The frontend
/// owns the format; the backend only understands enough to decide due-ness:
///   * `"every Nm"` / `"every Nh"` — fixed interval in seconds.
///   * `"daily HH:MM"` — once per day at the given UTC minute-of-day.
///   * `"at YYYY-MM-DDTHH:MM"` — one-shot at a specific local wall-clock time.
///
/// Anything else parses to `None` and is never triggered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schedule {
    /// Fixed interval, in seconds (always > 0).
    Every(i64),
    /// Daily at this minute-of-day (0..1440), interpreted in UTC.
    Daily(i64),
    /// One-shot absolute unix timestamp (seconds, UTC). Fires exactly once when
    /// `now >= ts`, then never again.
    At(i64),
}

/// Parse a card `schedule` string. Tolerant: case-insensitive, trims, returns
/// `None` for `null`-equivalents and anything unrecognised.
pub fn parse_schedule(raw: &str) -> Option<Schedule> {
    let s = raw.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix("every ") {
        let rest = rest.trim();
        let (num, unit_secs) = if let Some(n) = rest.strip_suffix('m') {
            (n, 60)
        } else if let Some(n) = rest.strip_suffix('h') {
            (n, 3600)
        } else {
            return None;
        };
        let n: i64 = num.trim().parse().ok()?;
        if n <= 0 {
            return None;
        }
        let interval = n.saturating_mul(unit_secs);
        // 2026-05-26 SE review round 2 (security): enforce a minimum
        // interval of 60 seconds. The scheduler tick polls every 30 s
        // (see RECONCILE_INTERVAL); intervals below that resolve to
        // fire-every-tick which DoS-es the task pool. Even at 1 min an
        // unattended workflow runs 1440x/day — high enough that we should
        // at least refuse sub-minute grain at the parse layer.
        const MIN_INTERVAL_SECS: i64 = 60;
        if interval < MIN_INTERVAL_SECS {
            return None;
        }
        return Some(Schedule::Every(interval));
    }
    if let Some(rest) = s.strip_prefix("daily ") {
        let rest = rest.trim();
        let (hh, mm) = rest.split_once(':')?;
        let hh: i64 = hh.trim().parse().ok()?;
        let mm: i64 = mm.trim().parse().ok()?;
        if !(0..24).contains(&hh) || !(0..60).contains(&mm) {
            return None;
        }
        return Some(Schedule::Daily(hh * 60 + mm));
    }
    if let Some(rest) = s.strip_prefix("at ") {
        // `at YYYY-MM-DDTHH:MM` (optionally `:SS`) — a LOCAL wall-clock instant.
        // Parse the calendar components defensively, reject anything impossible,
        // then interpret them as local time: build the UTC unix timestamp the
        // components would have if they were UTC, then subtract the machine's
        // local offset for that instant to land on the real UTC unix time.
        let rest = rest.trim();
        // `s` was lowercased at the top of the fn, so the ISO `T` separator is
        // now `t`. Split on `t` to keep the tolerant case-insensitive contract.
        let (date, time) = rest.split_once('t')?;
        // Date: YYYY-MM-DD.
        let mut date_parts = date.split('-');
        let year: i64 = date_parts.next()?.trim().parse().ok()?;
        let month: i64 = date_parts.next()?.trim().parse().ok()?;
        let day: i64 = date_parts.next()?.trim().parse().ok()?;
        if date_parts.next().is_some() {
            return None;
        }
        // Time: HH:MM optionally :SS.
        let mut time_parts = time.split(':');
        let hh: i64 = time_parts.next()?.trim().parse().ok()?;
        let mm: i64 = time_parts.next()?.trim().parse().ok()?;
        let ss: i64 = match time_parts.next() {
            Some(s) => s.trim().parse().ok()?,
            None => 0,
        };
        if time_parts.next().is_some() {
            return None;
        }
        // Reject impossible components. Day validity is checked against the
        // month's real length (incl. leap-year February) below.
        if !(1..=12).contains(&month) || day < 1 {
            return None;
        }
        if !(0..24).contains(&hh) || !(0..60).contains(&mm) || !(0..60).contains(&ss) {
            return None;
        }
        let local_unix = civil_to_local_unix(year, month, day, hh, mm, ss)?;
        // Components are LOCAL wall-clock: subtract the machine offset at that
        // instant to recover the true UTC unix timestamp.
        let ts = local_unix - local_utc_offset_secs(local_unix);
        return Some(Schedule::At(ts));
    }
    None
}

/// Convert a Gregorian calendar date+time (interpreted as if it were UTC) to a
/// unix timestamp in seconds, validating the day against the month's real
/// length (incl. leap-year February). Returns `None` for an impossible date.
/// Caller applies the local-offset correction for `at`'s wall-clock semantics.
fn civil_to_local_unix(year: i64, month: i64, day: i64, hh: i64, mm: i64, ss: i64) -> Option<i64> {
    // Days in each month for a common (non-leap) year, Jan..Dec.
    const DAYS_IN_MONTH: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mut max_day = DAYS_IN_MONTH[(month - 1) as usize];
    if month == 2 && is_leap {
        max_day = 29;
    }
    if day > max_day {
        return None;
    }
    // days_from_civil (Howard Hinnant): days since 1970-01-01 for a y/m/d.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1; // [0,365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// Decide whether a schedule is due at `now` (unix seconds), given the unix
/// time it last fired (`last_fired`, `None` if never).
///
/// `Every(n)`: due when at least `n` seconds have elapsed since `last_fired`.
/// A never-fired interval card is *not* due immediately — it fires one window
/// after first being seen (handled by the caller seeding `last_fired = now`).
///
/// `Daily(m)`: due when `now` is at/after today's `m`-th minute and the card
/// has not already fired within the current day's window.
/// Current machine UTC offset in seconds (east of UTC positive) for the given
/// unix timestamp, via libc `localtime_r().tm_gmtoff`. Returns 0 (UTC) if the
/// call fails. Used to interpret `daily HH:MM` in the user's LOCAL wall clock.
#[cfg(unix)]
fn local_utc_offset_secs(now: i64) -> i64 {
    // SAFETY: localtime_r writes into a zeroed `tm` we own; on success we read
    // the plain `tm_gmtoff` integer field. No pointers escape.
    unsafe {
        let t = now as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return 0;
        }
        tm.tm_gmtoff as i64
    }
}

#[cfg(not(unix))]
fn local_utc_offset_secs(_now: i64) -> i64 {
    0
}

/// UTC-based scheduling predicate. Thin wrapper over
/// [`schedule_is_due_at_offset`] with a zero offset — preserves the original
/// pure, deterministic contract used by the unit tests. The live scheduler
/// uses the offset-aware variant so `daily HH:MM` fires in local time, so in
/// non-test builds this convenience wrapper has no caller.
#[cfg_attr(not(test), allow(dead_code))]
pub fn schedule_is_due(sched: Schedule, now: i64, last_fired: Option<i64>) -> bool {
    schedule_is_due_at_offset(sched, now, last_fired, 0)
}

/// Like [`schedule_is_due`] but interprets `Daily(minute_of_day)` against a
/// wall clock shifted by `offset_secs` (seconds east of UTC). The scheduler
/// passes the machine's current local offset so "daily 09:00" fires at 09:00
/// LOCAL, not 09:00 UTC. `offset_secs == 0` reproduces the original UTC
/// behavior. `Every` and `At` schedules are offset-independent (`At`'s
/// wall-clock→UTC conversion already happened at parse time).
pub fn schedule_is_due_at_offset(
    sched: Schedule,
    now: i64,
    last_fired: Option<i64>,
    offset_secs: i64,
) -> bool {
    match sched {
        Schedule::Every(interval) => match last_fired {
            Some(last) => now.saturating_sub(last) >= interval,
            // Never fired: not due — caller seeds last_fired so the first
            // trigger lands one full interval later.
            None => false,
        },
        Schedule::Daily(minute_of_day) => {
            // Shift `now` into local wall-clock seconds to find local midnight,
            // then convert the local target time back to a real (UTC) unix
            // timestamp so the `now` / `last_fired` comparisons stay in unix
            // time. With offset 0 this collapses to the original UTC math.
            let local_now = now + offset_secs;
            let local_day_start = local_now - local_now.rem_euclid(86_400);
            let target = (local_day_start + minute_of_day * 60) - offset_secs;
            if now < target {
                return false;
            }
            // Due if we haven't already fired at/after today's target time.
            match last_fired {
                Some(last) => last < target,
                None => true,
            }
        }
        Schedule::At(ts) => {
            // One-shot: due once `now` reaches the target and it has not yet
            // fired. `At` is offset-independent — `ts` is already a real UTC
            // unix timestamp (the wall-clock→UTC conversion happened at parse).
            if now < ts {
                return false;
            }
            // Fire EXACTLY once: once last_fired >= ts it is never due again.
            // A never-fired `At` whose ts is already in the PAST IS due — so a
            // one-shot scheduled for a time the app was closed still runs once
            // on the next launch (the reconcile loop is careful NOT to seed
            // last_fired=now for `At`, which would otherwise swallow it). We
            // accept the catch-up rather than a staleness cap: these are
            // explicit user-set one-shots, so a missed reminder should still
            // fire rather than vanish silently.
            match last_fired {
                Some(last) => last < ts,
                None => true,
            }
        }
    }
}

/// Tauri event name emitted when a scheduled card is due. Payload shape:
/// `{ "workflow_id": i64, "card_id": string }`.
pub const TRIGGER_EVENT: &str = "workflow-trigger";

/// How often the scheduler scans all workflows for due cards.
const SCAN_INTERVAL_SECS: u64 = 30;

/// Prune the persisted `workflow_card_fired` table at most once every this many
/// scans when nothing changed. In steady state (no fires, no edited/deleted
/// workflows) the prune is a pure no-op read of the whole table, so running it
/// on every 30s tick is wasted disk work. We still prune immediately whenever a
/// card fires or the set of live cards shrinks (see `scheduler_scan`), so a
/// deleted workflow's rows never linger long; this cap only governs the idle
/// case. 20 ticks ≈ every 10 minutes.
const IDLE_PRUNE_EVERY_N_SCANS: u64 = 20;

/// A workflow's extracted schedule, cached so the hot scan does not re-parse the
/// `graph_json` blob on every 30s tick. `updated_at` is the invalidation key:
/// any `save_workflow` bumps it (see `save_workflow`), so a stale cache entry is
/// detected and re-parsed, guaranteeing a freshly-edited schedule takes effect
/// on the very next scan.
struct CachedSchedules {
    updated_at: i64,
    /// `(card_id, parsed schedule)` for every card whose `schedule` parsed.
    cards: Vec<(String, Schedule)>,
}

/// Cache of parsed schedules keyed by `workflow_id`. Entries are invalidated by
/// `updated_at` mismatch and dropped when their workflow disappears, so the map
/// stays bounded across a long app session.
type ScheduleCache = std::collections::HashMap<i64, CachedSchedules>;

/// Parse a workflow's `graph_json` into the `(card_id, Schedule)` pairs the
/// scheduler cares about. Cards without a recognised `schedule` are dropped.
/// Returns an empty vec if the blob does not parse or lacks a `cards` array —
/// the caller treats that as "no schedulable cards" (and caches the empty result
/// so the unparseable blob is not re-parsed every tick).
fn extract_schedules(graph_json: &str) -> Vec<(String, Schedule)> {
    let graph: serde_json::Value = match serde_json::from_str(graph_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let cards = match graph.get("cards").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for card in cards {
        let card_id = match card.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };
        let sched = match card.get("schedule").and_then(|v| v.as_str()) {
            Some(s) => match parse_schedule(s) {
                Some(parsed) => parsed,
                None => continue,
            },
            None => continue,
        };
        out.push((card_id.to_string(), sched));
    }
    out
}

/// One scheduler scan: load every workflow's lightweight schedule row, resolve
/// its parsed schedules (from `cache`, re-parsing only rows whose `updated_at`
/// changed), and for each due card emit `workflow-trigger`. `last_fired` tracks
/// the last unix time a card fired (keyed by `"<workflow_id>:<card_id>"`) so an
/// interval card fires once per window, not every scan. Newly-seen interval
/// cards are seeded with `now` so their first fire lands a full window later.
///
/// `scans_since_prune` is incremented and reset here to throttle the idle
/// disk-prune (see `IDLE_PRUNE_EVERY_N_SCANS`).
fn scheduler_scan(
    app: &tauri::AppHandle,
    last_fired: &mut std::collections::HashMap<String, i64>,
    cache: &mut ScheduleCache,
    scans_since_prune: &mut u64,
    now: i64,
) {
    use tauri::Emitter;

    let rows = match list_workflow_schedule_rows() {
        Ok(w) => w,
        Err(e) => {
            crate::diagnostics::warn_with(
                "workflows",
                "scheduler scan failed to list workflows",
                serde_json::json!({ "error": e.to_string() }),
            );
            return;
        }
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut live_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    // Resolve the machine's local UTC offset once for this scan so `daily
    // HH:MM` cards fire at the user's local wall-clock time, not UTC.
    let tz_offset = local_utc_offset_secs(now);
    // Batch this tick's seed + fire upserts into one transaction (see
    // `persist_card_last_fired_batch`) instead of an upsert per card.
    let mut pending_persist: Vec<(String, i64, i64)> = Vec::new();

    // Set false if we break out of the scan early on a shutdown request: the
    // `seen`/`live_ids` sets are then incomplete, so the post-loop bookkeeping
    // (cache/last_fired retention and especially the disk prune keyed off
    // `seen`) must be skipped — pruning against a partial `seen` would delete
    // valid persisted fire records for not-yet-scanned live cards.
    let mut scan_complete = true;

    for row in &rows {
        // Bug (review 2026-06-13, low): bail out of a long scan promptly if a
        // shutdown was requested mid-flight. `start_scheduler` only checks the
        // flag at the loop top and after the `select!`, so without this an
        // in-progress scan over a large workflow set would keep emitting
        // triggers during teardown. We break (not return) so the cards already
        // marked fired this tick still get their batched persist below —
        // otherwise they'd lack a disk record and could re-fire after restart.
        if crate::is_shutting_down() {
            scan_complete = false;
            break;
        }
        live_ids.insert(row.id);
        // Re-parse only when the row changed: a cache hit on a matching
        // `updated_at` reuses the previously parsed schedules; any edit bumps
        // `updated_at` (in `save_workflow`) and forces a re-parse, so a newly
        // edited schedule takes effect on the next scan without re-parsing every
        // unchanged blob every tick.
        let hit = matches!(cache.get(&row.id), Some(c) if c.updated_at == row.updated_at);
        if !hit {
            // Cache miss: this workflow was edited (or is new) since we last
            // parsed it — only NOW do we pay to read + parse its graph_json.
            let cards = match fetch_workflow_graph_json(row.id) {
                Ok(json) => extract_schedules(&json),
                Err(e) => {
                    crate::diagnostics::warn_with(
                        "workflows",
                        "scheduler could not read workflow graph_json",
                        serde_json::json!({ "id": row.id, "error": e.to_string() }),
                    );
                    Vec::new()
                }
            };
            cache.insert(
                row.id,
                CachedSchedules {
                    updated_at: row.updated_at,
                    cards,
                },
            );
        }
        let entry = cache
            .get(&row.id)
            .expect("inserted on miss / present on hit");

        for (card_id, sched) in &entry.cards {
            let sched = *sched;
            let key = format!("{}:{}", row.id, card_id);
            seen.insert(key.clone());

            // Seed a never-seen interval card so its first fire lands one full
            // window from now rather than immediately. Persisted so a restart
            // does not reset the window. Gated to `Every` ON PURPOSE: `Daily`
            // anchors to a wall-clock time, and `At` is a one-shot — seeding
            // last_fired=now for an `At` whose ts is already past would make it
            // satisfy `last_fired >= ts` and NEVER fire. Do not broaden this.
            if matches!(sched, Schedule::Every(_)) && !last_fired.contains_key(&key) {
                last_fired.insert(key.clone(), now);
                pending_persist.push((key, row.id, now));
                continue;
            }

            if schedule_is_due_at_offset(sched, now, last_fired.get(&key).copied(), tz_offset) {
                last_fired.insert(key.clone(), now);
                // Queue the fire time so a `daily HH:MM` card cannot multi-fire
                // across app restarts within the same day. The in-memory insert
                // above prevents re-fire within THIS process; the persist (run
                // once at end of tick) guards the restart window. If it fails we
                // keep the in-memory mark (no 30s re-fire spam) but log loudly
                // so the residual restart-re-fire risk is diagnosable.
                pending_persist.push((key, row.id, now));
                // RACE (LOW): `row` is a snapshot from the start of this scan; a
                // concurrent `delete_workflow` could remove the workflow between
                // the snapshot and this emit. That is benign — `app.emit`
                // serializes a JSON payload and never panics on a stale id, and
                // the frontend `workflow-trigger` handler already no-ops when
                // the workflow is missing or its graph fails to parse. We
                // deliberately do NOT re-query existence here: a re-check would
                // add a DB round-trip on the hot path to close a window that the
                // frontend already tolerates.
                let _ = app.emit(
                    TRIGGER_EVENT,
                    serde_json::json!({ "workflow_id": row.id, "card_id": card_id }),
                );
            }
        }
    }

    // Always flush this tick's seeds + fires, even on an early shutdown break:
    // cards we already marked fired in-memory must get a disk record or they
    // could re-fire after restart.
    warn_if_persist_batch_failed(&pending_persist);

    // The remaining bookkeeping keys off the fully-populated `seen`/`live_ids`
    // sets. On an early shutdown break they're incomplete, so skip it: the cache
    // and `last_fired` map are in-memory and discarded on exit anyway, and a
    // disk prune keyed off a partial `seen` would delete valid fire records for
    // not-yet-scanned live cards.
    if !scan_complete {
        return;
    }

    // Drop cache entries for workflows that no longer exist so the cache can't
    // grow unbounded across a long app session.
    cache.retain(|id, _| live_ids.contains(id));

    // Drop in-memory tracking for cards that no longer exist so the map can't
    // grow unbounded as workflows are edited/deleted over a long session.
    let before = last_fired.len();
    last_fired.retain(|k, _| seen.contains(k));
    let cards_disappeared = last_fired.len() != before;

    // Prune the persisted table only when something actually changed (a card
    // fired/was seeded, or the live-card set shrank) or periodically when idle.
    // In steady state this avoids a full-table scan + delete loop every 30s.
    *scans_since_prune += 1;
    let changed = !pending_persist.is_empty() || cards_disappeared;
    if changed || *scans_since_prune >= IDLE_PRUNE_EVERY_N_SCANS {
        let _ = prune_card_last_fired(&seen);
        *scans_since_prune = 0;
    }
}

/// Start the app-lifetime workflow scheduler. Spawns a tokio task that scans
/// every ~30s for due cards and emits `workflow-trigger`. Runs only while the
/// app is open — the per-card timer state lives in memory and is not persisted.
///
/// `shutdown` is the app-level `Notify` flipped on `RunEvent::Exit`; the loop
/// `select!`s on it so the task exits promptly on app exit instead of being
/// torn down mid-sleep with the runtime.
pub fn start_scheduler(app: tauri::AppHandle, shutdown: std::sync::Arc<tokio::sync::Notify>) {
    tauri::async_runtime::spawn(async move {
        // Seed from the persisted table so daily/interval cards keep their
        // last-fired state across app restarts.
        let mut last_fired: std::collections::HashMap<String, i64> =
            load_card_last_fired().unwrap_or_default();
        // Parsed-schedule cache (keyed by workflow id, invalidated by
        // `updated_at`) so the hot scan does not re-JSON-parse every graph blob
        // each tick. Lives across the loop's lifetime; bounded by pruning gone
        // workflows each scan.
        let mut cache: ScheduleCache = ScheduleCache::new();
        // Ticks since the persisted fired-table was last pruned, to throttle the
        // idle prune (see `IDLE_PRUNE_EVERY_N_SCANS`).
        let mut scans_since_prune: u64 = 0;
        loop {
            // Sticky shutdown-flag check, in addition to `.notified()`.
            // `notify_waiters()` only wakes parked waiters; if the exit
            // handler fires while this task is inside `scheduler_scan`
            // (synchronous, holds the runtime for the scan duration) the
            // notify would land with no waiter parked. Checking the flag at
            // the top of each iteration AND after the select! covers both
            // orderings without leaking the loop past shutdown.
            if crate::is_shutting_down() {
                break;
            }
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS)) => {}
            }
            if crate::is_shutting_down() {
                break;
            }
            scheduler_scan(
                &app,
                &mut last_fired,
                &mut cache,
                &mut scans_since_prune,
                now_unix(),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD_GRAPH: &str = r#"{
        "cards": [
            {"id":"a","name":"Card A","preset":"default","prompt":"hi",
             "tools":["fs"],"schedule":"every 30m","backend":null,"x":10,"y":20}
        ],
        "edges": [{"from":"a","to":"b"}]
    }"#;

    #[test]
    fn validate_graph_accepts_good_shape() {
        assert!(validate_graph_json(GOOD_GRAPH).is_ok());
        // Empty graph is valid.
        assert!(validate_graph_json(r#"{"cards":[],"edges":[]}"#).is_ok());
        // Null schedule/backend allowed.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0}],"edges":[]}"#
        )
        .is_ok());
    }

    #[test]
    fn validate_graph_accepts_optional_unattended_flag() {
        // Present + boolean → accepted.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"unattended":true}],"edges":[]}"#
        )
        .is_ok());
        // Present but not a boolean → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"unattended":"yes"}],"edges":[]}"#
        )
        .is_err());
    }

    #[test]
    fn validate_graph_accepts_optional_model_and_placed() {
        // Both present + correctly typed → accepted.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"model":"llama3","placed":true}],"edges":[]}"#
        )
        .is_ok());
        // Null model → accepted.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"model":null,"placed":false}],"edges":[]}"#
        )
        .is_ok());
        // model wrong type → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"model":7}],"edges":[]}"#
        )
        .is_err());
        // placed wrong type → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"placed":"yes"}],"edges":[]}"#
        )
        .is_err());
    }

    #[test]
    fn validate_graph_accepts_optional_system_prompt() {
        // Present + string → accepted.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"systemPrompt":"Be terse."}],"edges":[]}"#
        )
        .is_ok());
        // Null → accepted (means: fall back to preset).
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"systemPrompt":null}],"edges":[]}"#
        )
        .is_ok());
        // Absent → accepted (legacy graphs).
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0}],"edges":[]}"#
        )
        .is_ok());
        // Wrong type → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"systemPrompt":42}],"edges":[]}"#
        )
        .is_err());
        // Object (would otherwise pass JSON shape) → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"systemPrompt":{"foo":"bar"}}],"edges":[]}"#
        )
        .is_err());
        // Oversized (> 32 KiB) → rejected. Build a 33 KiB string body.
        let huge = "a".repeat(33 * 1024);
        let graph = format!(
            r#"{{"cards":[{{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"systemPrompt":"{huge}"}}],"edges":[]}}"#
        );
        assert!(validate_graph_json(&graph).is_err());
    }

    #[test]
    fn validate_graph_accepts_optional_card_color() {
        // Hex string → accepted. Double-hash raw delimiter because the
        // `"#` in the hex value would close a single-hash `r#"…"#`.
        assert!(validate_graph_json(
            r##"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"color":"#6366f1"}],"edges":[]}"##
        )
        .is_ok());
        // Null + absent → accepted.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"color":null}],"edges":[]}"#
        )
        .is_ok());
        // Wrong type → rejected.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"color":42}],"edges":[]}"#
        )
        .is_err());
        // Oversized (> 64 bytes) → rejected.
        let huge = "x".repeat(80);
        let graph = format!(
            r#"{{"cards":[{{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0,"color":"{huge}"}}],"edges":[]}}"#
        );
        assert!(validate_graph_json(&graph).is_err());
    }

    #[test]
    fn validate_graph_rejects_malformed() {
        // Not JSON.
        assert!(validate_graph_json("{not json").is_err());
        // Not an object.
        assert!(validate_graph_json("[1,2,3]").is_err());
        // Missing keys.
        assert!(validate_graph_json(r#"{"cards":[]}"#).is_err());
        assert!(validate_graph_json(r#"{"edges":[]}"#).is_err());
        // Wrong types.
        assert!(validate_graph_json(r#"{"cards":{},"edges":[]}"#).is_err());
        // Card missing a required field.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","tools":[],"schedule":null,"backend":null,"x":0,"y":0}],"edges":[]}"#
        )
        .is_err());
        // Card field wrong type.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":1,"name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":0,"y":0}],"edges":[]}"#
        )
        .is_err());
        // tools not a string array.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[1],"schedule":null,"backend":null,"x":0,"y":0}],"edges":[]}"#
        )
        .is_err());
        // x not a number.
        assert!(validate_graph_json(
            r#"{"cards":[{"id":"a","name":"n","preset":"p","prompt":"q","tools":[],"schedule":null,"backend":null,"x":"0","y":0}],"edges":[]}"#
        )
        .is_err());
        // Edge missing 'to'.
        assert!(validate_graph_json(r#"{"cards":[],"edges":[{"from":"a"}]}"#).is_err());
    }

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_workflow_tables(&conn).unwrap();
        // Bring the in-memory DB up to the same schema the migration ladder
        // produces in production — the v9 column the delete-by-equality path
        // depends on is not part of the base CREATE TABLE.
        ensure_card_fired_workflow_id_column(&conn).unwrap();
        conn
    }

    #[test]
    fn workflow_tables_migration_fresh_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_workflow_tables(&conn).expect("first");
        ensure_workflow_tables(&conn).expect("second must not error");
        ensure_workflow_tables(&conn).expect("third must not error");
        for table in ["workflows", "workflow_runs"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} table should exist exactly once");
        }
    }

    /// Drive save/list directly on an in-memory connection (the public
    /// `save_workflow` uses the global pool — this mirrors its logic to keep
    /// the round-trip test pool-free).
    fn save_into(conn: &Connection, id: Option<i64>, name: &str, graph: &str) -> Result<i64> {
        validate_graph_json(graph)?;
        match id {
            None => {
                conn.execute(
                    "INSERT INTO workflows (name, graph_json, created_at, updated_at)
                     VALUES (?1, ?2, 100, 100)",
                    params![name, graph],
                )?;
                Ok(conn.last_insert_rowid())
            }
            Some(existing) => {
                conn.execute(
                    "UPDATE workflows SET name=?1, graph_json=?2, updated_at=200 WHERE id=?3",
                    params![name, graph, existing],
                )?;
                Ok(existing)
            }
        }
    }

    #[test]
    fn workflow_save_round_trip() {
        let conn = fresh_db();
        let id = save_into(&conn, None, "My Flow", GOOD_GRAPH).expect("insert");
        let (name, graph): (String, String) = conn
            .query_row(
                "SELECT name, graph_json FROM workflows WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "My Flow");
        assert!(validate_graph_json(&graph).is_ok());

        // Update path keeps the same id.
        let same =
            save_into(&conn, Some(id), "Renamed", r#"{"cards":[],"edges":[]}"#).expect("update");
        assert_eq!(same, id);
        let name2: String = conn
            .query_row("SELECT name FROM workflows WHERE id=?1", params![id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name2, "Renamed");
    }

    #[test]
    fn workflow_save_rejects_malformed_graph() {
        let conn = fresh_db();
        assert!(save_into(&conn, None, "Bad", "{not json").is_err());
        // Nothing was inserted.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflows", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn card_last_fired_table_persists_and_prunes() {
        let conn = fresh_db();
        // Upsert mirrors persist_card_last_fired_batch (the public fn uses the pool).
        let upsert = |k: &str, wid: i64, ts: i64| {
            conn.execute(
                "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(card_key) DO UPDATE SET
                    workflow_id = excluded.workflow_id,
                    last_fired = excluded.last_fired",
                params![k, wid, ts],
            )
            .unwrap();
        };
        upsert("1:a", 1, 100);
        upsert("1:b", 1, 200);
        // Upsert overwrites.
        upsert("1:a", 1, 999);
        let got: i64 = conn
            .query_row(
                "SELECT last_fired FROM workflow_card_fired WHERE card_key='1:a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(got, 999, "upsert must overwrite last_fired");

        // Prune everything not in the keep-set.
        conn.execute(
            "DELETE FROM workflow_card_fired WHERE card_key NOT IN ('1:a')",
            [],
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflow_card_fired", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "prune must drop stale card keys");
    }

    /// The original `delete_workflow` used `card_key LIKE '<id>:%'` which would
    /// over-match if any future scheme produced colliding prefixes. The v9
    /// migration adds a real INTEGER column so equality-deletes are precise.
    /// This test seeds rows for two workflows whose ids share a digit-prefix
    /// (1 vs 10) and asserts deleting one does not nuke the other.
    #[test]
    fn delete_workflow_removes_only_matching_card_fired_rows() {
        let conn = fresh_db();
        let upsert = |k: &str, wid: i64, ts: i64| {
            conn.execute(
                "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(card_key) DO UPDATE SET
                    workflow_id = excluded.workflow_id,
                    last_fired = excluded.last_fired",
                params![k, wid, ts],
            )
            .unwrap();
        };
        // Two workflows with prefix-colliding ids: 1 and 10.
        upsert("1:a", 1, 100);
        upsert("1:b", 1, 200);
        upsert("10:x", 10, 300);
        upsert("10:y", 10, 400);

        // Delete-by-equality (the new shape of `delete_workflow`).
        conn.execute(
            "DELETE FROM workflow_card_fired WHERE workflow_id = ?1",
            params![1_i64],
        )
        .unwrap();

        let rows: Vec<(String, i64)> = {
            let mut s = conn
                .prepare("SELECT card_key, workflow_id FROM workflow_card_fired ORDER BY card_key")
                .unwrap();
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        // Workflow 10's rows must survive — they share the digit prefix `1`
        // but not the workflow_id, which is what the old LIKE pattern got
        // wrong in spirit (and would mishandle under a future scheme).
        assert_eq!(
            rows,
            vec![("10:x".to_string(), 10), ("10:y".to_string(), 10)],
            "workflow 10 rows must be untouched when workflow 1 is deleted"
        );
    }

    #[test]
    fn parse_workflow_id_prefix_extracts_integer_head() {
        assert_eq!(parse_workflow_id_prefix("1:a"), Some(1));
        assert_eq!(parse_workflow_id_prefix("42:card-7"), Some(42));
        // No colon → no parse.
        assert_eq!(parse_workflow_id_prefix("not-a-key"), None);
        // Non-integer head → no parse (used by backfill, which leaves these
        // rows with workflow_id = NULL for later prune).
        assert_eq!(parse_workflow_id_prefix("abc:x"), None);
    }

    #[test]
    fn card_fired_workflow_id_migration_is_idempotent_and_backfills() {
        // Seed the pre-migration shape (no workflow_id column).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workflow_card_fired (
                card_key TEXT PRIMARY KEY,
                last_fired INTEGER NOT NULL
             );
             INSERT INTO workflow_card_fired (card_key, last_fired) VALUES
                ('1:a', 100), ('1:b', 200), ('10:x', 300),
                ('bogus-no-colon', 400);",
        )
        .unwrap();

        // Apply twice — must not error second time.
        ensure_card_fired_workflow_id_column(&conn).unwrap();
        ensure_card_fired_workflow_id_column(&conn).unwrap();

        // Column exists.
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('workflow_card_fired')
                 WHERE name = 'workflow_id'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);

        // Parseable keys are backfilled; unparseable ones stay NULL and will be
        // pruned on the next scheduler scan.
        let rows: Vec<(String, Option<i64>)> = {
            let mut s = conn
                .prepare("SELECT card_key, workflow_id FROM workflow_card_fired ORDER BY card_key")
                .unwrap();
            s.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        // SQLite ORDER BY on TEXT is lexicographic, so "10:x" sorts before
        // "1:a". The order is incidental — the assertion below is about
        // backfill correctness, not ordering.
        assert_eq!(
            rows,
            vec![
                ("10:x".to_string(), Some(10)),
                ("1:a".to_string(), Some(1)),
                ("1:b".to_string(), Some(1)),
                ("bogus-no-colon".to_string(), None),
            ]
        );
    }

    #[test]
    fn parse_schedule_handles_supported_formats() {
        assert_eq!(parse_schedule("every 30m"), Some(Schedule::Every(1800)));
        assert_eq!(parse_schedule("EVERY 2H"), Some(Schedule::Every(7200)));
        assert_eq!(parse_schedule("  every 1m  "), Some(Schedule::Every(60)));
        assert_eq!(parse_schedule("daily 09:00"), Some(Schedule::Daily(540)));
        assert_eq!(parse_schedule("daily 23:59"), Some(Schedule::Daily(1439)));
    }

    #[test]
    fn parse_schedule_rejects_unparseable() {
        assert_eq!(parse_schedule(""), None);
        assert_eq!(parse_schedule("   "), None);
        assert_eq!(parse_schedule("hourly"), None);
        assert_eq!(parse_schedule("every"), None);
        assert_eq!(parse_schedule("every 0m"), None);
        assert_eq!(parse_schedule("every -5m"), None);
        assert_eq!(parse_schedule("every 10d"), None);
        assert_eq!(parse_schedule("daily 25:00"), None);
        assert_eq!(parse_schedule("daily 09:99"), None);
        assert_eq!(parse_schedule("daily noon"), None);
        assert_eq!(parse_schedule("cron * * * * *"), None);
    }

    #[test]
    fn interval_schedule_is_due_after_window() {
        let s = Schedule::Every(1800);
        // Never fired: not due (caller seeds last_fired).
        assert!(!schedule_is_due(s, 10_000, None));
        // Fired recently: not due.
        assert!(!schedule_is_due(s, 10_000, Some(9_000)));
        // A full window elapsed: due.
        assert!(schedule_is_due(s, 11_800, Some(10_000)));
        assert!(schedule_is_due(s, 99_999, Some(10_000)));
    }

    #[test]
    fn daily_schedule_is_due_once_per_window() {
        // Target = 09:00 UTC = 540 min = 32_400 s into the day.
        let s = Schedule::Daily(540);
        let day = 20_000 * 86_400; // some arbitrary day boundary
                                   // Before the target time: not due.
        assert!(!schedule_is_due(s, day + 30_000, None));
        // At/after target, never fired today: due.
        assert!(schedule_is_due(s, day + 32_400, None));
        assert!(schedule_is_due(s, day + 40_000, None));
        // Already fired at/after today's target: not due again today.
        assert!(!schedule_is_due(s, day + 50_000, Some(day + 32_400)));
        // Last fired was yesterday: due again today.
        assert!(schedule_is_due(s, day + 40_000, Some(day - 1_000)));
    }

    #[test]
    fn daily_schedule_respects_local_offset() {
        // C6 (2026-06-01): "daily HH:MM" fires in LOCAL wall-clock time. With a
        // UTC+1 offset, "daily 09:00" must fire at 08:00 UTC, not 09:00 UTC.
        let day = 86_400 * 20_000_i64; // a UTC midnight (divisible by 86400)
        let nine = Schedule::Daily(9 * 60); // "daily 09:00"
        let off = 3600; // UTC+1

        // Just before 08:00 UTC → not due yet.
        assert!(!schedule_is_due_at_offset(
            nine,
            day + 8 * 3600 - 60,
            None,
            off
        ));
        // At 08:00 UTC (== 09:00 local) → first fire is due.
        assert!(schedule_is_due_at_offset(nine, day + 8 * 3600, None, off));
        // Already fired this local day → not due again.
        assert!(!schedule_is_due_at_offset(
            nine,
            day + 9 * 3600,
            Some(day + 8 * 3600),
            off
        ));
        // Sanity: with offset 0 the same 08:00 UTC instant is NOT yet due
        // (target is 09:00 UTC) — proves the offset is what shifted the fire.
        assert!(!schedule_is_due_at_offset(nine, day + 8 * 3600, None, 0));
    }

    #[test]
    fn parse_schedule_handles_at_one_shot() {
        // `at YYYY-MM-DDTHH:MM` is a LOCAL wall-clock instant. The parser
        // subtracts the machine's local offset, so to assert an exact unix value
        // we reconstruct it the same way the parser does (offset for that
        // instant). civil_to_local_unix gives the components-as-UTC seconds.
        let local = civil_to_local_unix(2027, 1, 15, 9, 30, 0).unwrap();
        let expected = local - local_utc_offset_secs(local);
        assert_eq!(
            parse_schedule("at 2027-01-15T09:30"),
            Some(Schedule::At(expected))
        );
        // Case-insensitive + trims, like the other branches.
        assert_eq!(
            parse_schedule("  AT 2027-01-15T09:30  "),
            Some(Schedule::At(expected))
        );

        // Optional seconds.
        let local_s = civil_to_local_unix(2027, 1, 15, 9, 30, 45).unwrap();
        let expected_s = local_s - local_utc_offset_secs(local_s);
        assert_eq!(
            parse_schedule("at 2027-01-15T09:30:45"),
            Some(Schedule::At(expected_s))
        );

        // Leap-year Feb 29 is valid.
        assert!(parse_schedule("at 2028-02-29T00:00").is_some());
    }

    #[test]
    fn parse_schedule_rejects_malformed_at() {
        // Non-leap-year Feb 29, impossible month/day/hour/minute/second.
        assert_eq!(parse_schedule("at 2027-02-29T00:00"), None);
        assert_eq!(parse_schedule("at 2027-13-01T00:00"), None);
        assert_eq!(parse_schedule("at 2027-00-01T00:00"), None);
        assert_eq!(parse_schedule("at 2027-04-31T00:00"), None);
        assert_eq!(parse_schedule("at 2027-01-00T00:00"), None);
        assert_eq!(parse_schedule("at 2027-01-15T24:00"), None);
        assert_eq!(parse_schedule("at 2027-01-15T09:60"), None);
        assert_eq!(parse_schedule("at 2027-01-15T09:30:60"), None);
        // Structurally broken: missing T, missing pieces, junk, extra parts.
        assert_eq!(parse_schedule("at 2027-01-15 09:30"), None);
        assert_eq!(parse_schedule("at 2027-01-15"), None);
        assert_eq!(parse_schedule("at 2027-01T09:30"), None);
        assert_eq!(parse_schedule("at not-a-date"), None);
        assert_eq!(parse_schedule("at 2027-01-15T09"), None);
        assert_eq!(parse_schedule("at 2027-01-15T09:30:00:00"), None);
        assert_eq!(parse_schedule("at 2027-1-15-09T09:30"), None);
        assert_eq!(parse_schedule("at "), None);
    }

    #[test]
    fn at_schedule_fires_exactly_once() {
        let ts = 2_000_000_000_i64;
        let s = Schedule::At(ts);

        // Future ts, never fired: not due.
        assert!(!schedule_is_due(s, ts - 1, None));
        // At/after ts, never fired: due.
        assert!(schedule_is_due(s, ts, None));
        assert!(schedule_is_due(s, ts + 10_000, None));
        // A never-fired one-shot whose ts is already in the PAST IS due — a
        // missed reminder (app was closed) still runs once on next launch.
        assert!(schedule_is_due(s, ts + 86_400 * 30, None));
        // Once fired at/after ts: never due again (exactly-once).
        assert!(!schedule_is_due(s, ts + 1, Some(ts)));
        assert!(!schedule_is_due(s, ts + 99_999, Some(ts)));
        assert!(!schedule_is_due(s, ts + 99_999, Some(ts + 5)));
        // `At` ignores the offset arg (ts is already real UTC).
        assert!(schedule_is_due_at_offset(s, ts, None, 3600));
        assert!(!schedule_is_due_at_offset(s, ts - 1, None, -3600));
    }

    /* ─────────────────────────────────────────────────────────────────────
     * Stress tests — persistence + scheduler dedup + size caps.
     *
     * Each test owns its own in-memory `Connection` (via `fresh_db()`) and
     * replicates the SQL the public functions run, mirroring the pattern in
     * `save_into` above. This keeps the global rusqlite pool out of the loop
     * so the tests are hermetic and parallel-safe.
     * ───────────────────────────────────────────────────────────────────── */

    /// Insert a workflow_run row exactly the way `record_run` would, but on a
    /// caller-owned Connection. Mirrors the production INSERT.
    fn record_run_into(
        conn: &Connection,
        workflow_id: i64,
        status: &str,
        results_json: &str,
        ts: i64,
    ) {
        conn.execute(
            "INSERT INTO workflow_runs (workflow_id, started_at, status, results_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![workflow_id, ts, status, results_json],
        )
        .unwrap();
    }

    #[test]
    fn list_runs_query_uses_index_for_workflow_id() {
        // EXPLAIN QUERY PLAN should show `USING INDEX idx_workflow_runs_wf`
        // for the WHERE workflow_id = ?1 lookup. Without the index, a list
        // call on a fat workflow_runs table would be O(N) scan.
        let conn = fresh_db();
        // Seed one row to make the optimizer pick the index (a totally empty
        // table sometimes plans a full scan).
        record_run_into(&conn, 1, "ok", r#"{"status":"ok","cards":[]}"#, 1);
        let mut stmt = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT id, workflow_id, started_at, status, results_json
                 FROM workflow_runs WHERE workflow_id = ?1
                 ORDER BY started_at DESC, id DESC LIMIT 100",
            )
            .unwrap();
        let plans: Vec<String> = stmt
            .query_map(params![1_i64], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let joined = plans.join("\n");
        assert!(
            joined.contains("idx_workflow_runs_wf"),
            "expected list_runs plan to use idx_workflow_runs_wf; got:\n{joined}"
        );
    }

    #[test]
    fn insert_10000_runs_then_list_is_fast_and_bounded() {
        // Smoke test that the run-list query stays well-bounded even when a
        // workflow has accumulated 10k recorded runs. RUNS_LIMIT caps the
        // returned rows at 100; the index + LIMIT must keep the wall-clock
        // negligible on this hardware.
        use std::time::Instant;
        let conn = fresh_db();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..10_000 {
            tx.execute(
                "INSERT INTO workflow_runs (workflow_id, started_at, status, results_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![1_i64, i, "ok", "{}"],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        let t0 = Instant::now();
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_id, started_at, status, results_json
                 FROM workflow_runs WHERE workflow_id = ?1
                 ORDER BY started_at DESC, id DESC LIMIT 100",
            )
            .unwrap();
        let rows: Vec<i64> = stmt
            .query_map(params![1_i64], |r| r.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let dt = t0.elapsed();
        assert_eq!(rows.len(), 100, "RUNS_LIMIT caps the returned rows at 100");
        assert!(
            dt.as_millis() < 200,
            "list_runs over 10k rows took {dt:?}, expected < 200ms"
        );
    }

    #[test]
    fn record_run_into_raw_helper_skips_cap_public_record_run_enforces_it() {
        // `record_run_into` is the RAW test helper (takes an explicit conn for
        // fresh-db isolation + perf seeding) and intentionally has NO size cap.
        // The PUBLIC `workflows::record_run` enforces the MAX_GRAPH_BYTES cap
        // itself (so the scheduler, which calls it directly, can't persist an
        // unbounded results_json — not just the IPC command boundary). This
        // test pins the raw helper's no-cap behavior used for the 10k-row perf
        // seed below; the public cap is covered by the command-layer tests.
        let conn = fresh_db();
        let huge = "x".repeat(2 * 1024 * 1024); // 2 MiB
        record_run_into(&conn, 1, "ok", &huge, 100);
        let stored_len: i64 = conn
            .query_row(
                "SELECT length(results_json) FROM workflow_runs WHERE workflow_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored_len as usize, huge.len());
        // Sanity-check the cap constant lives where we think it lives.
        assert_eq!(MAX_GRAPH_BYTES, 1_048_576);
    }

    #[test]
    fn validate_graph_accepts_just_under_1_mib_and_rejects_just_over() {
        // Build graph_json strings straddling MAX_GRAPH_BYTES. The validator
        // enforces the 1 MiB ceiling itself (sec audit 2026-06) — a compromised
        // renderer can't smuggle a multi-MB blob past `save_workflow`.
        let make = |prompt_len: usize| {
            let prompt = "a".repeat(prompt_len);
            format!(
                r#"{{"cards":[{{"id":"a","name":"n","preset":"p","prompt":"{prompt}","tools":[],"schedule":null,"backend":null,"x":0,"y":0}}],"edges":[]}}"#
            )
        };
        let under = make(1_048_000);
        let over = make(1_200_000);
        assert!(under.len() < MAX_GRAPH_BYTES);
        assert!(over.len() > MAX_GRAPH_BYTES);
        assert!(validate_graph_json(&under).is_ok());
        let err = validate_graph_json(&over).unwrap_err().to_string();
        assert!(err.contains("too large"), "got: {err}");
    }

    #[test]
    fn dedup_gate_prevents_double_fire_within_one_window() {
        // Simulates the `Every(60)` (one-minute) card across two consecutive
        // scheduler ticks 30s apart. The dedup gate is the `last_fired` map
        // + `schedule_is_due`: a card must NOT fire twice within one window.
        let s = Schedule::Every(60);
        let mut last_fired: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();

        let key = "1:a".to_string();
        let mut now = 1_000_000_i64;

        // First scan: never-seen interval card is SEEDED, not fired.
        let seed_first = matches!(s, Schedule::Every(_)) && !last_fired.contains_key(&key);
        assert!(seed_first);
        last_fired.insert(key.clone(), now);

        // Tick + 30s: not due yet (interval is 60s).
        now += 30;
        assert!(!schedule_is_due(s, now, last_fired.get(&key).copied()));

        // Tick + 60s past seed: due. Fire and record.
        now += 30;
        assert!(schedule_is_due(s, now, last_fired.get(&key).copied()));
        last_fired.insert(key.clone(), now);

        // Same minute window, +5s later: dedup must hold.
        now += 5;
        assert!(!schedule_is_due(s, now, last_fired.get(&key).copied()));
    }

    #[test]
    fn dedup_gate_handles_many_cards_independently() {
        // 50 cards each with its own `Every(60)` schedule and own key. Ticking
        // the scheduler once must seed all 50; ticking again past the window
        // must fire all 50. The scan itself is O(N) over cards.
        use std::time::Instant;
        let s = Schedule::Every(60);
        let mut last_fired: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        let keys: Vec<String> = (0..50).map(|i| format!("1:c{i}")).collect();
        let mut now = 1_000_000_i64;

        // Seed pass.
        let t0 = Instant::now();
        for k in &keys {
            if !last_fired.contains_key(k) {
                last_fired.insert(k.clone(), now);
            }
        }
        let seed = t0.elapsed();
        assert!(seed.as_millis() < 50);

        // Advance past the window — every key is due once.
        now += 61;
        let mut fired = 0;
        for k in &keys {
            if schedule_is_due(s, now, last_fired.get(k).copied()) {
                fired += 1;
                last_fired.insert(k.clone(), now);
            }
        }
        assert_eq!(fired, 50);

        // Immediately re-scan — dedup must hold for every key.
        for k in &keys {
            assert!(!schedule_is_due(s, now, last_fired.get(k).copied()));
        }
    }

    #[test]
    fn delete_workflow_cleans_up_card_fired_rows() {
        // Simulates a workflow with active scheduled cards being deleted:
        // workflow_runs AND workflow_card_fired rows for that workflow must
        // disappear, while sibling workflows' rows must survive.
        let conn = fresh_db();
        // Seed two workflows in `workflow_card_fired`.
        for (k, wid) in [("1:a", 1_i64), ("1:b", 1_i64), ("2:a", 2_i64)] {
            conn.execute(
                "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
                 VALUES (?1, ?2, 100)",
                params![k, wid],
            )
            .unwrap();
        }
        // Also seed `workflow_runs` and `workflows` so the transactional
        // delete has rows to remove on every table.
        conn.execute(
            "INSERT INTO workflows (id, name, graph_json, created_at, updated_at)
             VALUES (1, 'W1', '{\"cards\":[],\"edges\":[]}', 0, 0),
                    (2, 'W2', '{\"cards\":[],\"edges\":[]}', 0, 0)",
            [],
        )
        .unwrap();
        record_run_into(&conn, 1, "ok", "{}", 100);
        record_run_into(&conn, 2, "ok", "{}", 100);

        // The production `delete_workflow` runs three statements in one tx —
        // do the same here against the in-memory connection.
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "DELETE FROM workflow_runs WHERE workflow_id = ?1",
            params![1_i64],
        )
        .unwrap();
        tx.execute(
            "DELETE FROM workflow_card_fired WHERE workflow_id = ?1",
            params![1_i64],
        )
        .unwrap();
        tx.execute("DELETE FROM workflows WHERE id = ?1", params![1_i64])
            .unwrap();
        tx.commit().unwrap();

        // Workflow 1 totally gone.
        let n_runs1: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let n_fired1: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_card_fired WHERE workflow_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_runs1, 0);
        assert_eq!(n_fired1, 0);
        // Workflow 2 untouched.
        let n_fired2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_card_fired WHERE workflow_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_fired2, 1);
    }

    #[test]
    fn renaming_a_card_id_orphans_old_card_fired_row_until_prune() {
        // FINDING: `workflow_card_fired` keys by `"<workflow_id>:<card_id>"`.
        // Renaming a card changes its card_id, so the old row is left behind
        // until the next scheduler scan calls `prune_card_last_fired` with a
        // `keep` set that no longer contains the old key. This test simulates
        // both halves of that flow.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
             VALUES ('1:old', 1, 100)",
            [],
        )
        .unwrap();

        // Renaming: a new row is upserted under the new key — the old one
        // sticks around because the rename path doesn't know to delete it
        // (it's keyed by frontend-supplied card id).
        conn.execute(
            "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
             VALUES ('1:new', 1, 200)
             ON CONFLICT(card_key) DO UPDATE SET last_fired = excluded.last_fired",
            [],
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflow_card_fired", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "old row is orphaned by a rename");

        // Prune emulating the scheduler pass with the new keep-set.
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
        keep.insert("1:new".to_string());
        // Public prune_card_last_fired uses the global pool, so emulate it
        // here against this connection.
        let existing: Vec<String> = {
            let mut s = conn
                .prepare("SELECT card_key FROM workflow_card_fired")
                .unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for k in existing {
            if !keep.contains(&k) {
                conn.execute(
                    "DELETE FROM workflow_card_fired WHERE card_key = ?1",
                    params![k],
                )
                .unwrap();
            }
        }
        let remaining: Vec<String> = {
            let mut s = conn
                .prepare("SELECT card_key FROM workflow_card_fired ORDER BY card_key")
                .unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(remaining, vec!["1:new".to_string()]);
    }

    #[test]
    fn prune_card_last_fired_keeps_table_bounded_under_churn() {
        // Simulate scheduler activity that churns many keys then prunes. The
        // table must converge to the size of the `keep` set on each pass.
        let conn = fresh_db();
        // Insert 1000 keys for workflow 1.
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..1000 {
            tx.execute(
                "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
                 VALUES (?1, 1, ?2)",
                params![format!("1:c{i}"), i as i64],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        // Keep only 5 of them.
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
        for i in 0..5 {
            keep.insert(format!("1:c{i}"));
        }
        // Inline emulation of `prune_card_last_fired`.
        let existing: Vec<String> = {
            let mut s = conn
                .prepare("SELECT card_key FROM workflow_card_fired")
                .unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for k in existing {
            if !keep.contains(&k) {
                conn.execute(
                    "DELETE FROM workflow_card_fired WHERE card_key = ?1",
                    params![k],
                )
                .unwrap();
            }
        }
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflow_card_fired", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 5, "prune must bound the table at keep.len()");
    }

    #[test]
    fn parse_schedule_rejects_cron_expression_every_minute() {
        // The brief mentions a card with `"* * * * *"` (every-minute cron).
        // The current parser does NOT understand cron syntax — it returns
        // None, which the scheduler treats as "never fire". This is a
        // CORRECTNESS guard (a misinterpreted cron field would fire all the
        // wrong times). Documenting the behavior so a future cron rollout
        // doesn't accidentally regress it.
        assert_eq!(parse_schedule("* * * * *"), None);
        // A few other cron-ish strings also rejected.
        assert_eq!(parse_schedule("0 * * * *"), None);
        assert_eq!(parse_schedule("@hourly"), None);
        assert_eq!(parse_schedule("@every 1m"), None);
    }

    #[test]
    fn workflow_runs_inserts_under_a_single_tx_are_atomic() {
        // Bulk insert pattern used in stress test above — must roll back
        // cleanly if a constraint blows mid-tx. workflow_runs has no UNIQUE
        // constraints aside from `id`, so simulate failure by deliberately
        // re-using an id within the tx.
        let conn = fresh_db();
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "INSERT INTO workflow_runs (id, workflow_id, started_at, status, results_json)
             VALUES (1, 1, 100, 'ok', '{}')",
            [],
        )
        .unwrap();
        // Duplicate id: should error.
        let dup = tx.execute(
            "INSERT INTO workflow_runs (id, workflow_id, started_at, status, results_json)
             VALUES (1, 1, 200, 'ok', '{}')",
            [],
        );
        assert!(dup.is_err(), "duplicate id must fail");
        // Roll back and confirm the first insert is gone too.
        tx.rollback().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflow_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn schedule_parser_accepts_lite_minute_grammar_only() {
        // Lock in the supported grammar in one place so regressions show up
        // immediately. Adding new shapes is fine — silently dropping support
        // for one of these is not.
        for (input, expected) in [
            ("every 1m", Schedule::Every(60)),
            ("every 1h", Schedule::Every(3600)),
            ("every 60m", Schedule::Every(3600)),
            ("Every 24H", Schedule::Every(86_400)),
            ("daily 00:00", Schedule::Daily(0)),
            ("daily 23:59", Schedule::Daily(1439)),
        ] {
            assert_eq!(parse_schedule(input), Some(expected), "input {input:?}");
        }
        // Saturation check: very large interval must not panic.
        assert!(parse_schedule("every 99999999h").is_some());
    }

    #[test]
    fn extract_schedules_drops_unparseable_and_unscheduled_cards() {
        // Two scheduled cards, one with a null schedule, one with a junk
        // schedule, one missing an id — only the two valid ones survive.
        let graph = r#"{
            "cards": [
                {"id":"a","schedule":"every 5m"},
                {"id":"b","schedule":"daily 09:30"},
                {"id":"c","schedule":null},
                {"id":"d","schedule":"banana"},
                {"schedule":"every 5m"}
            ],
            "edges": []
        }"#;
        let got = extract_schedules(graph);
        assert_eq!(
            got,
            vec![
                ("a".to_string(), Schedule::Every(300)),
                ("b".to_string(), Schedule::Daily(9 * 60 + 30)),
            ]
        );
        // Unparseable / shapeless blobs yield no schedules, never panic.
        assert!(extract_schedules("{not json").is_empty());
        assert!(extract_schedules(r#"{"edges":[]}"#).is_empty());
    }

    /// The cache re-parses a workflow ONLY when its `updated_at` changes. This
    /// drives the same get-or-parse decision `scheduler_scan` uses, asserting
    /// (1) an unchanged `updated_at` reuses the cached parse and (2) a bumped
    /// `updated_at` forces a re-parse so an edited schedule takes effect.
    #[test]
    fn schedule_cache_reparses_only_on_updated_at_change() {
        // Mirror the scan's cache lookup exactly. `parses` counts how often the
        // expensive `extract_schedules` path runs. We can't observe the calls
        // inside `scheduler_scan` directly (it needs an AppHandle), so reproduce
        // the cache-keying logic via a free fn that borrows the counter.
        fn resolve(
            cache: &mut ScheduleCache,
            parses: &mut u32,
            id: i64,
            updated_at: i64,
            graph_json: &str,
        ) -> Vec<(String, Schedule)> {
            match cache.get(&id) {
                Some(c) if c.updated_at == updated_at => c.cards.clone(),
                _ => {
                    *parses += 1;
                    let cards = extract_schedules(graph_json);
                    cache.insert(
                        id,
                        CachedSchedules {
                            updated_at,
                            cards: cards.clone(),
                        },
                    );
                    cards
                }
            }
        }

        let mut cache: ScheduleCache = ScheduleCache::new();
        let mut parses = 0u32;
        let v1 = r#"{"cards":[{"id":"a","schedule":"every 5m"}],"edges":[]}"#;
        let v2 = r#"{"cards":[{"id":"a","schedule":"every 10m"}],"edges":[]}"#;

        // First sight → parse.
        let r = resolve(&mut cache, &mut parses, 1, 100, v1);
        assert_eq!(r, vec![("a".to_string(), Schedule::Every(300))]);
        assert_eq!(parses, 1);

        // Same updated_at, even with a different blob, must NOT re-parse: the
        // cache trusts updated_at as the invalidation key (save_workflow always
        // bumps it on any graph change).
        let r = resolve(&mut cache, &mut parses, 1, 100, v2);
        assert_eq!(r, vec![("a".to_string(), Schedule::Every(300))]);
        assert_eq!(
            parses, 1,
            "unchanged updated_at must reuse the cached parse"
        );

        // Bumped updated_at → re-parse, new schedule takes effect.
        let r = resolve(&mut cache, &mut parses, 1, 200, v2);
        assert_eq!(r, vec![("a".to_string(), Schedule::Every(600))]);
        assert_eq!(parses, 2, "bumped updated_at must force a re-parse");
    }

    #[test]
    fn schedule_cache_drops_entries_for_gone_workflows() {
        // Mirror the scan's end-of-tick retain: a cache entry whose workflow is
        // no longer in the live set is dropped so the cache stays bounded.
        let mut cache: ScheduleCache = ScheduleCache::new();
        cache.insert(
            1,
            CachedSchedules {
                updated_at: 1,
                cards: vec![],
            },
        );
        cache.insert(
            2,
            CachedSchedules {
                updated_at: 1,
                cards: vec![],
            },
        );
        let live: std::collections::HashSet<i64> = [2].into_iter().collect();
        cache.retain(|id, _| live.contains(id));
        assert!(!cache.contains_key(&1), "gone workflow must be evicted");
        assert!(cache.contains_key(&2), "live workflow must stay cached");
    }

    #[test]
    fn persist_batch_upserts_all_rows_in_one_pass() {
        // The batched persist must upsert every row (insert-or-overwrite),
        // matching the per-card upsert it replaced. Drive the same SQL the batch
        // helper runs against an in-memory connection (the public fn uses the
        // pool); this keeps the round-trip pool-free while locking the upsert
        // semantics: later rows for the same key overwrite earlier ones.
        let conn = fresh_db();
        let upsert_batch = |rows: &[(&str, i64, i64)]| {
            let tx = conn.unchecked_transaction().unwrap();
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(card_key) DO UPDATE SET
                            workflow_id = excluded.workflow_id,
                            last_fired = excluded.last_fired",
                    )
                    .unwrap();
                for (k, wid, ts) in rows {
                    stmt.execute(params![k, wid, ts]).unwrap();
                }
            }
            tx.commit().unwrap();
        };

        // One tick: seed two, fire one.
        upsert_batch(&[("1:a", 1, 100), ("1:b", 1, 100), ("2:a", 2, 100)]);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM workflow_card_fired", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);

        // Next tick re-fires 1:a at a later ts; the upsert overwrites in place.
        upsert_batch(&[("1:a", 1, 160)]);
        let (n, ts): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), (SELECT last_fired FROM workflow_card_fired WHERE card_key='1:a')
                 FROM workflow_card_fired",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(n, 3, "re-fire must not add a row");
        assert_eq!(ts, 160, "re-fire must overwrite last_fired");
    }

    /// The idle-prune throttle: prune runs when something changed OR every Nth
    /// scan, but not on an idle tick in between. Drives the same gate logic as
    /// `scheduler_scan` to lock the steady-state behavior (no per-tick prune).
    #[test]
    fn idle_prune_gate_skips_unchanged_ticks() {
        // Free fn mirroring the gate in `scheduler_scan`: returns whether this
        // tick pruned and advances the counter in place.
        fn tick(scans_since_prune: &mut u64, changed: bool) -> bool {
            *scans_since_prune += 1;
            if changed || *scans_since_prune >= IDLE_PRUNE_EVERY_N_SCANS {
                *scans_since_prune = 0;
                true
            } else {
                false
            }
        }

        let mut scans = 0u64;
        let mut prunes = 0u32;

        // A changed tick prunes and resets the counter.
        if tick(&mut scans, true) {
            prunes += 1;
        }
        assert_eq!(prunes, 1);
        assert_eq!(scans, 0);

        // Idle ticks below the cap do NOT prune.
        for _ in 0..(IDLE_PRUNE_EVERY_N_SCANS - 1) {
            if tick(&mut scans, false) {
                prunes += 1;
            }
        }
        assert_eq!(prunes, 1, "idle ticks below cap must not prune");

        // The Nth idle tick crosses the cap and prunes once.
        if tick(&mut scans, false) {
            prunes += 1;
        }
        assert_eq!(prunes, 2, "Nth idle tick must prune");
        assert_eq!(scans, 0);
    }
}
