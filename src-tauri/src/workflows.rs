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

/// Persist a single card's last-fired unix time (upsert). `workflow_id` is
/// stored in a dedicated integer column so `delete_workflow` can delete by
/// equality — see `ensure_card_fired_workflow_id_column` for the rationale.
pub fn persist_card_last_fired(card_key: &str, workflow_id: i64, ts: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO workflow_card_fired (card_key, workflow_id, last_fired)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(card_key) DO UPDATE SET
            workflow_id = excluded.workflow_id,
            last_fired = excluded.last_fired",
        params![card_key, workflow_id, ts],
    )?;
    Ok(())
}

/// Drop persisted last-fired rows whose card_key is not in `keep` — keeps the
/// table from growing as workflows/cards are edited or deleted.
pub fn prune_card_last_fired(keep: &std::collections::HashSet<String>) -> Result<()> {
    let conn = get_db()?;
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("SELECT card_key FROM workflow_card_fired")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for k in existing {
        if !keep.contains(&k) {
            conn.execute(
                "DELETE FROM workflow_card_fired WHERE card_key = ?1",
                params![k],
            )?;
        }
    }
    Ok(())
}

/// Validate that `graph_json` parses as a JSON object of the shared shape:
/// `{ "cards": Card[], "edges": Edge[] }`. Each card must carry the required
/// keys with the right primitive types; each edge needs string `from`/`to`.
/// Returns a clear error on any deviation so the column never holds garbage.
pub fn validate_graph_json(graph_json: &str) -> Result<()> {
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
    let rows = stmt
        .query_map([], row_to_workflow)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
    let conn = get_db()?;
    let now = now_unix();
    match id {
        None => {
            conn.execute(
                "INSERT INTO workflows (name, graph_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)",
                params![name, graph_json, now],
            )?;
            Ok(conn.last_insert_rowid())
        }
        Some(existing) => {
            let changed = conn.execute(
                "UPDATE workflows SET name = ?1, graph_json = ?2, updated_at = ?3 WHERE id = ?4",
                params![name, graph_json, now, existing],
            )?;
            if changed == 0 {
                return Err(anyhow::anyhow!("workflow {existing} not found"));
            }
            Ok(existing)
        }
    }
}

pub fn delete_workflow(id: i64) -> Result<()> {
    let mut conn = get_db()?;
    // All three deletes go in a single transaction so a crash mid-delete can
    // never leave orphan run rows or fire-tracking rows pointing at a
    // workflow that no longer exists. `workflow_card_fired` carries a
    // dedicated `workflow_id` integer column (v9 migration) so we delete by
    // equality — the prior `card_key LIKE '<id>:%'` approach was fragile
    // against any future prefix-collision and over-matched once GLOB-style
    // patterns were considered.
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM workflow_runs WHERE workflow_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM workflow_card_fired WHERE workflow_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM workflows WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// Record a workflow run. Returns the new run id.
pub fn record_run(workflow_id: i64, status: &str, results_json: &str) -> Result<i64> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO workflow_runs (workflow_id, started_at, status, results_json)
         VALUES (?1, ?2, ?3, ?4)",
        params![workflow_id, now_unix(), status, results_json],
    )?;
    Ok(conn.last_insert_rowid())
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
///
/// Anything else parses to `None` and is never triggered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schedule {
    /// Fixed interval, in seconds (always > 0).
    Every(i64),
    /// Daily at this minute-of-day (0..1440), interpreted in UTC.
    Daily(i64),
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
    None
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
pub fn schedule_is_due(sched: Schedule, now: i64, last_fired: Option<i64>) -> bool {
    match sched {
        Schedule::Every(interval) => match last_fired {
            Some(last) => now.saturating_sub(last) >= interval,
            // Never fired: not due — caller seeds last_fired so the first
            // trigger lands one full interval later.
            None => false,
        },
        Schedule::Daily(minute_of_day) => {
            // NOTE: the "daily HH:MM" schedule string is interpreted as UTC.
            // `now.rem_euclid(86_400)` gives the seconds-since-the-UTC-midnight
            // because unix time itself is UTC-based; `day_start` is therefore
            // today's 00:00 UTC. The frontend currently shows the same HH:MM
            // verbatim — if/when local-time UX lands, convert at the IPC edge
            // so this comparison stays in UTC.
            let day_start = now - now.rem_euclid(86_400);
            let target = day_start + minute_of_day * 60;
            if now < target {
                return false;
            }
            // Due if we haven't already fired at/after today's target time.
            match last_fired {
                Some(last) => last < target,
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

/// One scheduler scan: load every workflow, parse each card's `schedule`, and
/// for each card that is due emit `workflow-trigger`. `last_fired` tracks the
/// last unix time a card fired (keyed by `"<workflow_id>:<card_id>"`) so an
/// interval card fires once per window, not every scan. Newly-seen interval
/// cards are seeded with `now` so their first fire lands a full window later.
fn scheduler_scan(
    app: &tauri::AppHandle,
    last_fired: &mut std::collections::HashMap<String, i64>,
    now: i64,
) {
    use tauri::Emitter;

    let workflows = match list_workflows() {
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

    for wf in &workflows {
        let graph: serde_json::Value = match serde_json::from_str(&wf.graph_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let cards = match graph.get("cards").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => continue,
        };
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
            let key = format!("{}:{}", wf.id, card_id);
            seen.insert(key.clone());

            // Seed a never-seen interval card so its first fire lands one full
            // window from now rather than immediately. Persisted so a restart
            // does not reset the window.
            if matches!(sched, Schedule::Every(_)) && !last_fired.contains_key(&key) {
                last_fired.insert(key.clone(), now);
                let _ = persist_card_last_fired(&key, wf.id, now);
                continue;
            }

            if schedule_is_due(sched, now, last_fired.get(&key).copied()) {
                last_fired.insert(key.clone(), now);
                // Persist the fire time so a `daily HH:MM` card cannot
                // multi-fire across app restarts within the same day.
                let _ = persist_card_last_fired(&key, wf.id, now);
                let _ = app.emit(
                    TRIGGER_EVENT,
                    serde_json::json!({ "workflow_id": wf.id, "card_id": card_id }),
                );
            }
        }
    }

    // Drop tracking for cards that no longer exist so the map can't grow
    // unbounded as workflows are edited/deleted over a long app session.
    last_fired.retain(|k, _| seen.contains(k));
    let _ = prune_card_last_fired(&seen);
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
            scheduler_scan(&app, &mut last_fired, now_unix());
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
        // Upsert mirrors persist_card_last_fired (the public fn uses the pool).
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
    fn record_run_into(conn: &Connection, workflow_id: i64, status: &str, results_json: &str, ts: i64) {
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
    fn record_run_layer_has_no_size_cap_only_command_does() {
        // FINDING: the `MAX_RESULTS_BYTES` cap lives in
        // `commands/workflows.rs`, NOT in `workflows::record_run`. A direct
        // call to the latter (e.g. an internal scheduler glue path) will
        // happily insert a 2 MiB JSON. This is the documented boundary.
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
    fn validate_graph_accepts_just_under_1_mib_and_handles_just_over() {
        // Build graph_json strings exactly straddling MAX_GRAPH_BYTES so the
        // 1 MiB boundary in `commands/workflows.rs` is exercised in spirit
        // (the validator itself has no cap — it just parses JSON).
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
        // The validator parses both successfully — the byte cap is a SEPARATE
        // gate at the command layer. Documenting the split.
        assert!(validate_graph_json(&under).is_ok());
        assert!(validate_graph_json(&over).is_ok());
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
        tx.execute("DELETE FROM workflow_runs WHERE workflow_id = ?1", params![1_i64])
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
            assert_eq!(
                parse_schedule(input),
                Some(expected),
                "input {input:?}"
            );
        }
        // Saturation check: very large interval must not panic.
        assert!(parse_schedule("every 99999999h").is_some());
    }
}
