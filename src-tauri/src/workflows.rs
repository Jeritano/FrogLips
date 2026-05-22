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

/// Persist a single card's last-fired unix time (upsert).
pub fn persist_card_last_fired(card_key: &str, ts: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO workflow_card_fired (card_key, last_fired) VALUES (?1, ?2)
         ON CONFLICT(card_key) DO UPDATE SET last_fired = excluded.last_fired",
        params![card_key, ts],
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
    // workflow that no longer exists. The `workflow_card_fired` rows are
    // keyed `"<workflow_id>:<card_id>"`, so we delete by `card_key LIKE
    // 'id:%'`. The escape clause is here as belt-and-suspenders even though
    // numeric ids cannot contain `%`/`_`/`\`.
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM workflow_runs WHERE workflow_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM workflow_card_fired WHERE card_key LIKE ?1 ESCAPE '\\'",
        params![format!("{id}:%")],
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
        return Some(Schedule::Every(n.saturating_mul(unit_secs)));
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
                let _ = persist_card_last_fired(&key, now);
                continue;
            }

            if schedule_is_due(sched, now, last_fired.get(&key).copied()) {
                last_fired.insert(key.clone(), now);
                // Persist the fire time so a `daily HH:MM` card cannot
                // multi-fire across app restarts within the same day.
                let _ = persist_card_last_fired(&key, now);
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
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS)) => {}
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
        let upsert = |k: &str, ts: i64| {
            conn.execute(
                "INSERT INTO workflow_card_fired (card_key, last_fired) VALUES (?1, ?2)
                 ON CONFLICT(card_key) DO UPDATE SET last_fired = excluded.last_fired",
                params![k, ts],
            )
            .unwrap();
        };
        upsert("1:a", 100);
        upsert("1:b", 200);
        // Upsert overwrites.
        upsert("1:a", 999);
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
}
