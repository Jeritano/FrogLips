//! Roundtable OUTCOME persistence — saved transcripts of completed roundtables.
//!
//! A roundtable's CONFIG (seats / topic / budget) is a reusable template owned
//! by the frontend (localStorage). This module persists the OUTCOME of a *run*:
//! the full transcript + totals, as a durable record in `db.sqlite` so it
//! survives navigation AND app restart, and can be listed, reopened, or
//! exported to a file later.
//!
//! `transcript_json` is owned + shaped by the frontend; the backend treats it as
//! opaque text and only caps its size.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::history::{get_db, now_unix};

/// Hard cap on a stored transcript blob. A long multi-round roundtable is far
/// under this; the cap just stops a malformed IPC call ballooning a row.
pub const MAX_TRANSCRIPT_BYTES: usize = 4_194_304; // 4 MiB

/// Keep at most this many outcomes per source table (LRU by created_at).
const RUNS_RETAIN: i64 = 50;

/// One stored outcome — metadata only. The large `transcript_json` blob is
/// fetched separately via `get_run` so list views stay cheap.
#[derive(Serialize)]
pub struct RoundtableRunSummary {
    pub id: i64,
    /// The frontend SavedTable id this outcome came from (null = ad-hoc run).
    pub table_id: Option<String>,
    pub name: String,
    pub topic: String,
    pub turns: i64,
    pub created_at: i64,
}

/// A full stored outcome, including the transcript blob.
#[derive(Serialize)]
pub struct RoundtableRun {
    pub id: i64,
    pub table_id: Option<String>,
    pub name: String,
    pub topic: String,
    pub turns: i64,
    pub transcript_json: String,
    pub created_at: i64,
}

/// Idempotently create the outcomes table. Wired into the migration ladder
/// (history.rs v17) and safe to re-run.
pub(crate) fn ensure_roundtable_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS roundtable_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id TEXT,
            name TEXT NOT NULL,
            topic TEXT NOT NULL,
            turns INTEGER NOT NULL,
            transcript_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_roundtable_runs_table
            ON roundtable_runs(table_id, created_at DESC);",
    )?;
    Ok(())
}

fn row_to_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<RoundtableRunSummary> {
    Ok(RoundtableRunSummary {
        id: r.get(0)?,
        table_id: r.get(1)?,
        name: r.get(2)?,
        topic: r.get(3)?,
        turns: r.get(4)?,
        created_at: r.get(5)?,
    })
}

/// Insert an outcome + trim the source table's history to `RUNS_RETAIN`, in one
/// transaction. Returns the new row id.
pub fn save_run(
    table_id: Option<&str>,
    name: &str,
    topic: &str,
    turns: i64,
    transcript_json: &str,
) -> Result<i64> {
    if transcript_json.len() > MAX_TRANSCRIPT_BYTES {
        bail!(
            "transcript exceeds {MAX_TRANSCRIPT_BYTES} bytes ({} given)",
            transcript_json.len()
        );
    }
    let mut conn = get_db()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO roundtable_runs (table_id, name, topic, turns, transcript_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![table_id, name, topic, turns, transcript_json, now_unix()],
    )?;
    let id = tx.last_insert_rowid();
    // Retention, scoped to THIS source table. `table_id IS ?1` matches the NULL
    // (ad-hoc) bucket too, so ad-hoc runs trim among themselves and never evict
    // a named table's history.
    tx.execute(
        "DELETE FROM roundtable_runs
         WHERE table_id IS ?1
           AND id NOT IN (
             SELECT id FROM roundtable_runs
             WHERE table_id IS ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2
           )",
        params![table_id, RUNS_RETAIN],
    )?;
    tx.commit()?;
    Ok(id)
}

/// List outcome summaries, newest first. `None` lists ALL; `Some(id)` filters to
/// one source table. Resilient: a malformed row is skipped + logged rather than
/// emptying the whole list.
pub fn list_runs(table_id: Option<&str>) -> Result<Vec<RoundtableRunSummary>> {
    let conn = get_db()?;
    let mut out = Vec::new();
    let collect =
        |rows: &mut rusqlite::Rows<'_>, out: &mut Vec<RoundtableRunSummary>| -> Result<()> {
            while let Some(r) = rows.next()? {
                match row_to_summary(r) {
                    Ok(s) => out.push(s),
                    Err(e) => crate::diagnostics::warn_with(
                        "roundtable",
                        "skipping unreadable outcome row",
                        serde_json::json!({ "error": e.to_string() }),
                    ),
                }
            }
            Ok(())
        };
    match table_id {
        Some(tid) => {
            let mut stmt = conn.prepare(
                "SELECT id, table_id, name, topic, turns, created_at
                 FROM roundtable_runs WHERE table_id = ?1
                 ORDER BY created_at DESC, id DESC",
            )?;
            let mut rows = stmt.query(params![tid])?;
            collect(&mut rows, &mut out)?;
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, table_id, name, topic, turns, created_at
                 FROM roundtable_runs ORDER BY created_at DESC, id DESC",
            )?;
            let mut rows = stmt.query([])?;
            collect(&mut rows, &mut out)?;
        }
    }
    Ok(out)
}

/// Fetch one full outcome (with the transcript blob).
pub fn get_run(id: i64) -> Result<RoundtableRun> {
    let conn = get_db()?;
    conn.query_row(
        "SELECT id, table_id, name, topic, turns, transcript_json, created_at
         FROM roundtable_runs WHERE id = ?1",
        params![id],
        |r| {
            Ok(RoundtableRun {
                id: r.get(0)?,
                table_id: r.get(1)?,
                name: r.get(2)?,
                topic: r.get(3)?,
                turns: r.get(4)?,
                transcript_json: r.get(5)?,
                created_at: r.get(6)?,
            })
        },
    )
    .context("roundtable outcome not found")
}

/// Delete one outcome.
pub fn delete_run(id: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute("DELETE FROM roundtable_runs WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_roundtable_tables(&c).unwrap();
        c
    }

    #[test]
    fn ensure_is_idempotent() {
        let c = mem();
        ensure_roundtable_tables(&c).expect("second");
        ensure_roundtable_tables(&c).expect("third");
    }

    #[test]
    fn retention_keeps_newest_per_table_in_memory() {
        // Drive the retention SQL directly against an in-memory conn (the public
        // save_run uses the global pool). Insert RUNS_RETAIN+5 for one table_id,
        // then run the same trim and assert the cap holds + newest survive.
        let c = mem();
        for i in 0..(RUNS_RETAIN + 5) {
            c.execute(
                "INSERT INTO roundtable_runs (table_id, name, topic, turns, transcript_json, created_at)
                 VALUES ('t1', ?1, 'topic', 1, '{}', ?2)",
                params![format!("run{i}"), i],
            )
            .unwrap();
        }
        c.execute(
            "DELETE FROM roundtable_runs
             WHERE table_id IS 't1'
               AND id NOT IN (
                 SELECT id FROM roundtable_runs WHERE table_id IS 't1'
                 ORDER BY created_at DESC, id DESC LIMIT ?1
               )",
            params![RUNS_RETAIN],
        )
        .unwrap();
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM roundtable_runs WHERE table_id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, RUNS_RETAIN);
        // The oldest (created_at 0..4) should be gone; newest (created_at high) kept.
        let oldest_kept: i64 = c
            .query_row(
                "SELECT min(created_at) FROM roundtable_runs WHERE table_id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(oldest_kept, 5);
    }
}
