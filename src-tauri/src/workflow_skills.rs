//! Procedural memory for workflows — named, reusable `(tool, args)` sequences
//! that future agent runs can list, inspect, invoke, or delete.
//!
//! Schema (created by the v14 migration):
//!   `workflow_skills`         — one row per skill, scoped to a workflow.
//!   `workflow_skills_history` — shadow table; the prior row is pushed here
//!                               every time an existing skill is overwritten.
//!                               Capped at 50 entries per (workflow_id, name)
//!                               so the audit trail cannot grow unbounded.
//!
//! `workflow_skills.workflow_id` carries `ON DELETE CASCADE`; dropping a
//! workflow drops its skills. History rows have no FK (they are an audit
//! trail) — they live and die by the explicit caps in this module.
//!
//! All validation lives at save time so the column never holds garbage:
//!   * name: 1..=64 chars, `[A-Za-z0-9_-]+`
//!   * description: 1..=512 chars
//!   * steps_json: JSON array, ≤50 elements, ≤32 KiB total
//!   * each step: object with `tool: string` and `args: object`
//!   * forbidden tool names (RCE-amplifier guard): `workflow_invoke_skill`,
//!     `workflow_save_skill`, `workflow_delete_skill`, `spawn_subagent`,
//!     `await_subagents`.

use anyhow::Result;
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::history::{get_db, now_unix};

/// Hard cap on `steps_json` length.
pub const MAX_STEPS_JSON_BYTES: usize = 32 * 1024;
/// Hard cap on the number of steps per skill.
pub const MAX_STEPS: usize = 50;
/// Hard cap on `name` length (chars; ASCII so chars == bytes).
pub const MAX_NAME_LEN: usize = 64;
/// Hard cap on `description` length (chars).
pub const MAX_DESCRIPTION_LEN: usize = 512;
/// How many history rows to retain per (workflow_id, name).
pub const HISTORY_CAP_PER_SKILL: i64 = 50;

/// Tool names that must never appear inside a skill's `steps_json`. Allowing
/// these would let a skill recursively author/invoke other skills or spawn
/// subagents — both are RCE amplifiers in the agent loop. The list is the
/// closed set the spec calls out; any future tool with similar reach should
/// be added here.
const FORBIDDEN_STEP_TOOLS: &[&str] = &[
    "workflow_invoke_skill",
    "workflow_save_skill",
    "workflow_delete_skill",
    "spawn_subagent",
    "await_subagents",
];

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

#[derive(Debug, Serialize)]
pub struct SkillSummary {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub last_used_at: Option<i64>,
    pub invocation_count: i64,
}

#[derive(Debug, Serialize)]
pub struct SkillFull {
    pub id: i64,
    pub workflow_id: i64,
    pub name: String,
    pub description: String,
    pub steps_json: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub invocation_count: i64,
}

/// A structured error kind that the IPC layer flattens to `String`. The `kind`
/// tag is what the frontend / agent loop branches on; the message is for
/// humans.
#[derive(Debug)]
pub struct SkillError {
    pub kind: &'static str,
    pub message: String,
}

impl std::fmt::Display for SkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for SkillError {}

fn err(kind: &'static str, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(SkillError {
        kind,
        message: message.into(),
    })
}

/// Idempotently create the `workflow_skills` and `workflow_skills_history`
/// tables and their indexes. Called from the v14 migration rung; safe to
/// re-run against a schema that already has them.
pub(crate) fn ensure_workflow_skills_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_skills (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id      INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            name             TEXT NOT NULL,
            description      TEXT NOT NULL,
            steps_json       TEXT NOT NULL,
            created_at       INTEGER NOT NULL,
            last_used_at     INTEGER,
            invocation_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE (workflow_id, name)
         );
         CREATE INDEX IF NOT EXISTS idx_workflow_skills_lookup
            ON workflow_skills(workflow_id, name);
         CREATE TABLE IF NOT EXISTS workflow_skills_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id  INTEGER NOT NULL,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL,
            steps_json   TEXT NOT NULL,
            overwrote_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_workflow_skills_history_lookup
            ON workflow_skills_history(workflow_id, name, overwrote_at DESC);",
    )?;
    Ok(())
}

/// Validate a candidate skill `name`. Returns a `SkillError` with
/// `kind = "invalid_name"` on any failure.
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(err("invalid_name", "name must not be empty"));
    }
    if name.len() > MAX_NAME_LEN {
        return Err(err(
            "invalid_name",
            format!("name exceeds {MAX_NAME_LEN} chars"),
        ));
    }
    if !NAME_RE.is_match(name) {
        return Err(err(
            "invalid_name",
            "name must match [A-Za-z0-9_-]+ (no spaces, slashes, or punctuation)",
        ));
    }
    Ok(())
}

fn validate_description(description: &str) -> Result<()> {
    if description.is_empty() {
        return Err(err("invalid_description", "description must not be empty"));
    }
    if description.len() > MAX_DESCRIPTION_LEN {
        return Err(err(
            "invalid_description",
            format!("description exceeds {MAX_DESCRIPTION_LEN} chars"),
        ));
    }
    Ok(())
}

/// Validate `steps_json`. Checks:
///   * size cap (32 KiB),
///   * parses as a JSON array,
///   * at most `MAX_STEPS` elements,
///   * each step is an object with `tool: string` and `args: object`,
///   * no step tool is in `FORBIDDEN_STEP_TOOLS`.
fn validate_steps_json(steps_json: &str) -> Result<()> {
    if steps_json.len() > MAX_STEPS_JSON_BYTES {
        return Err(err(
            "invalid_steps",
            format!("steps_json exceeds {MAX_STEPS_JSON_BYTES} bytes"),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(steps_json).map_err(|e| {
        err(
            "invalid_steps",
            format!("steps_json is not valid JSON: {e}"),
        )
    })?;
    let arr = value
        .as_array()
        .ok_or_else(|| err("invalid_steps", "steps_json must be a JSON array"))?;
    if arr.len() > MAX_STEPS {
        return Err(err(
            "invalid_steps",
            format!("steps_json has {} elements (max {MAX_STEPS})", arr.len()),
        ));
    }
    for (i, step) in arr.iter().enumerate() {
        let obj = step
            .as_object()
            .ok_or_else(|| err("invalid_steps", format!("step {i} must be an object")))?;
        let tool = obj
            .get("tool")
            .ok_or_else(|| err("invalid_steps", format!("step {i} missing 'tool'")))?
            .as_str()
            .ok_or_else(|| err("invalid_steps", format!("step {i} 'tool' must be a string")))?;
        if tool.is_empty() {
            return Err(err(
                "invalid_steps",
                format!("step {i} 'tool' must not be empty"),
            ));
        }
        if FORBIDDEN_STEP_TOOLS.contains(&tool) {
            return Err(err(
                "forbidden_step_tool",
                format!("step {i} uses forbidden tool '{tool}'"),
            ));
        }
        match obj.get("args") {
            Some(v) if v.is_object() => {}
            Some(_) => {
                return Err(err(
                    "invalid_steps",
                    format!("step {i} 'args' must be an object"),
                ))
            }
            None => return Err(err("invalid_steps", format!("step {i} missing 'args'"))),
        }
    }
    Ok(())
}

/// Save a skill — either insert a new row or overwrite an existing
/// (workflow_id, name) row. On overwrite the prior row is pushed to
/// `workflow_skills_history` and that history list is trimmed to the most
/// recent `HISTORY_CAP_PER_SKILL` entries.
///
/// Errors:
///   * `invalid_name` / `invalid_description` / `invalid_steps` —
///     validation failure.
///   * `forbidden_step_tool` — at least one step uses a banned tool name.
///   * `name_collision` — a row with this (workflow_id, name) already exists
///     and `overwrite=false`.
pub fn save(
    workflow_id: i64,
    name: &str,
    description: &str,
    steps_json: &str,
    overwrite: bool,
) -> Result<i64> {
    validate_name(name)?;
    validate_description(description)?;
    validate_steps_json(steps_json)?;

    let mut conn = get_db()?;
    let now = now_unix();
    let tx = conn.transaction()?;

    // Look up the existing row, if any. The UNIQUE(workflow_id, name) index
    // backs the lookup.
    let existing: Option<(i64, String, String, String)> = tx
        .query_row(
            "SELECT id, name, description, steps_json
             FROM workflow_skills WHERE workflow_id = ?1 AND name = ?2",
            params![workflow_id, name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();

    let id = match existing {
        None => {
            tx.execute(
                "INSERT INTO workflow_skills
                    (workflow_id, name, description, steps_json,
                     created_at, last_used_at, invocation_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)",
                params![workflow_id, name, description, steps_json, now],
            )?;
            tx.last_insert_rowid()
        }
        Some((existing_id, old_name, old_desc, old_steps)) => {
            if !overwrite {
                // Drop the open transaction (no writes happened on this path,
                // but be explicit).
                drop(tx);
                return Err(err(
                    "name_collision",
                    format!(
                        "skill '{}' already exists for workflow {}",
                        name, workflow_id
                    ),
                ));
            }
            // Push the prior row to history before overwriting.
            tx.execute(
                "INSERT INTO workflow_skills_history
                    (workflow_id, name, description, steps_json, overwrote_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workflow_id, old_name, old_desc, old_steps, now],
            )?;
            // Trim history beyond the cap. The OFFSET-LIMIT trick selects ids
            // older than the most recent `HISTORY_CAP_PER_SKILL`; SQLite's
            // `LIMIT -1 OFFSET N` form means "all rows past the first N".
            tx.execute(
                "DELETE FROM workflow_skills_history
                 WHERE id IN (
                    SELECT id FROM workflow_skills_history
                    WHERE workflow_id = ?1 AND name = ?2
                    ORDER BY overwrote_at DESC, id DESC
                    LIMIT -1 OFFSET ?3
                 )",
                params![workflow_id, name, HISTORY_CAP_PER_SKILL],
            )?;
            // Update the live row in place.
            tx.execute(
                "UPDATE workflow_skills
                 SET description = ?1, steps_json = ?2
                 WHERE id = ?3",
                params![description, steps_json, existing_id],
            )?;
            existing_id
        }
    };

    tx.commit()?;
    Ok(id)
}

/// List the skills for a workflow, summary form only (no `steps_json`).
/// Ordered by `name ASC` for stable listing in the agent loop's tool catalog.
pub fn list(workflow_id: i64) -> Result<Vec<SkillSummary>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, description, last_used_at, invocation_count
         FROM workflow_skills WHERE workflow_id = ?1
         ORDER BY name ASC",
    )?;
    let rows = stmt
        .query_map(params![workflow_id], |r| {
            Ok(SkillSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                last_used_at: r.get(3)?,
                invocation_count: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Fetch a single skill by (workflow_id, name). `Ok(None)` if it doesn't
/// exist — distinct from an error.
pub fn get(workflow_id: i64, name: &str) -> Result<Option<SkillFull>> {
    let conn = get_db()?;
    let row = conn
        .query_row(
            "SELECT id, workflow_id, name, description, steps_json,
                    created_at, last_used_at, invocation_count
             FROM workflow_skills WHERE workflow_id = ?1 AND name = ?2",
            params![workflow_id, name],
            |r| {
                Ok(SkillFull {
                    id: r.get(0)?,
                    workflow_id: r.get(1)?,
                    name: r.get(2)?,
                    description: r.get(3)?,
                    steps_json: r.get(4)?,
                    created_at: r.get(5)?,
                    last_used_at: r.get(6)?,
                    invocation_count: r.get(7)?,
                })
            },
        )
        .ok();
    Ok(row)
}

/// Delete a skill. No-op (returns Ok) if the row doesn't exist — keeps the
/// caller's idempotent "remove it if you have it" semantics simple.
pub fn delete(workflow_id: i64, name: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "DELETE FROM workflow_skills WHERE workflow_id = ?1 AND name = ?2",
        params![workflow_id, name],
    )?;
    Ok(())
}

/// Bump `invocation_count` and stamp `last_used_at = now` for a skill. Used
/// by the agent loop right after a successful `workflow_invoke_skill`. Returns
/// `Ok(())` even if the row is gone — the caller has no recovery path beyond
/// "the skill was deleted between fetch and invoke" and the metric is
/// best-effort.
pub fn record_invocation(workflow_id: i64, name: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE workflow_skills
         SET invocation_count = invocation_count + 1,
             last_used_at = ?1
         WHERE workflow_id = ?2 AND name = ?3",
        params![now_unix(), workflow_id, name],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an in-memory SQLite carrying just enough of the production
    /// schema for the workflow_skills tests: a `workflows` row to satisfy
    /// the FK, plus the v14 tables. FKs are enabled so cascade tests work.
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open mem db");
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE workflows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                graph_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        ensure_workflow_skills_tables(&conn).unwrap();
        conn
    }

    fn insert_workflow(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO workflows (id, name, graph_json, created_at, updated_at)
             VALUES (?1, 'wf', '{\"cards\":[],\"edges\":[]}', 1, 1)",
            params![id],
        )
        .unwrap();
    }

    /// Mirror `save` but on a caller-owned connection, so the tests don't
    /// touch the global rusqlite pool. The logic must stay in sync with the
    /// public `save`.
    fn save_into(
        conn: &mut Connection,
        workflow_id: i64,
        name: &str,
        description: &str,
        steps_json: &str,
        overwrite: bool,
        now: i64,
    ) -> Result<i64> {
        validate_name(name)?;
        validate_description(description)?;
        validate_steps_json(steps_json)?;
        let tx = conn.transaction()?;
        let existing: Option<(i64, String, String, String)> = tx
            .query_row(
                "SELECT id, name, description, steps_json
                 FROM workflow_skills WHERE workflow_id = ?1 AND name = ?2",
                params![workflow_id, name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let id = match existing {
            None => {
                tx.execute(
                    "INSERT INTO workflow_skills
                        (workflow_id, name, description, steps_json,
                         created_at, last_used_at, invocation_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)",
                    params![workflow_id, name, description, steps_json, now],
                )?;
                tx.last_insert_rowid()
            }
            Some((existing_id, old_name, old_desc, old_steps)) => {
                if !overwrite {
                    drop(tx);
                    return Err(err(
                        "name_collision",
                        format!("skill '{name}' already exists for workflow {workflow_id}"),
                    ));
                }
                tx.execute(
                    "INSERT INTO workflow_skills_history
                        (workflow_id, name, description, steps_json, overwrote_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![workflow_id, old_name, old_desc, old_steps, now],
                )?;
                tx.execute(
                    "DELETE FROM workflow_skills_history
                     WHERE id IN (
                        SELECT id FROM workflow_skills_history
                        WHERE workflow_id = ?1 AND name = ?2
                        ORDER BY overwrote_at DESC, id DESC
                        LIMIT -1 OFFSET ?3
                     )",
                    params![workflow_id, name, HISTORY_CAP_PER_SKILL],
                )?;
                tx.execute(
                    "UPDATE workflow_skills
                     SET description = ?1, steps_json = ?2
                     WHERE id = ?3",
                    params![description, steps_json, existing_id],
                )?;
                existing_id
            }
        };
        tx.commit()?;
        Ok(id)
    }

    fn err_kind(e: &anyhow::Error) -> Option<&'static str> {
        e.downcast_ref::<SkillError>().map(|s| s.kind)
    }

    const GOOD_STEPS: &str = r#"[
        {"tool":"fs_read","args":{"path":"/tmp/x"}},
        {"tool":"fs_write","args":{"path":"/tmp/y","content":"hi"}}
    ]"#;

    #[test]
    fn migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workflows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                graph_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        ensure_workflow_skills_tables(&conn).expect("first");
        ensure_workflow_skills_tables(&conn).expect("second must not error");
        ensure_workflow_skills_tables(&conn).expect("third must not error");
        for table in ["workflow_skills", "workflow_skills_history"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} should exist exactly once");
        }
    }

    #[test]
    fn save_validates_name_charset() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        // Spaces: rejected.
        let r = save_into(&mut conn, 1, "bad name", "d", GOOD_STEPS, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_name"));
        // Slashes: rejected.
        let r = save_into(&mut conn, 1, "bad/name", "d", GOOD_STEPS, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_name"));
        // Empty: rejected.
        let r = save_into(&mut conn, 1, "", "d", GOOD_STEPS, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_name"));
        // 65 chars: rejected.
        let too_long = "a".repeat(65);
        let r = save_into(&mut conn, 1, &too_long, "d", GOOD_STEPS, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_name"));
        // Punctuation: rejected.
        let r = save_into(&mut conn, 1, "name.with.dots", "d", GOOD_STEPS, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_name"));
        // Good names accepted.
        save_into(&mut conn, 1, "good-name_1", "d", GOOD_STEPS, false, 100).unwrap();
        save_into(&mut conn, 1, "Another1", "d", GOOD_STEPS, false, 100).unwrap();
    }

    #[test]
    fn save_rejects_forbidden_step_tool() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        for forbidden in FORBIDDEN_STEP_TOOLS {
            let steps = format!(r#"[{{"tool":"{forbidden}","args":{{}}}}]"#);
            let r = save_into(&mut conn, 1, "skill", "d", &steps, false, 100);
            assert_eq!(
                err_kind(&r.unwrap_err()),
                Some("forbidden_step_tool"),
                "tool '{forbidden}' must be rejected"
            );
        }
    }

    #[test]
    fn save_rejects_oversized_steps_json() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        // Build a steps_json > 32 KiB. A single step with a long args.path
        // string clears the cap easily.
        let pad = "x".repeat(33 * 1024);
        let steps = format!(r#"[{{"tool":"fs","args":{{"path":"{pad}"}}}}]"#);
        assert!(steps.len() > MAX_STEPS_JSON_BYTES);
        let r = save_into(&mut conn, 1, "skill", "d", &steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
    }

    #[test]
    fn save_rejects_invalid_json() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        let r = save_into(&mut conn, 1, "skill", "d", "{not json", false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Object instead of array.
        let r = save_into(&mut conn, 1, "skill", "d", "{}", false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
    }

    #[test]
    fn save_rejects_step_with_no_tool() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        // Missing 'tool'.
        let steps = r#"[{"args":{}}]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Non-string tool.
        let steps = r#"[{"tool":7,"args":{}}]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Empty tool string.
        let steps = r#"[{"tool":"","args":{}}]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Missing args.
        let steps = r#"[{"tool":"fs"}]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // args not an object.
        let steps = r#"[{"tool":"fs","args":[]}]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Step not an object.
        let steps = r#"["not an object"]"#;
        let r = save_into(&mut conn, 1, "skill", "d", steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
        // Too many steps (>50).
        let mut elems = Vec::with_capacity(51);
        for _ in 0..51 {
            elems.push(r#"{"tool":"fs","args":{}}"#.to_string());
        }
        let steps = format!("[{}]", elems.join(","));
        let r = save_into(&mut conn, 1, "skill", "d", &steps, false, 100);
        assert_eq!(err_kind(&r.unwrap_err()), Some("invalid_steps"));
    }

    #[test]
    fn name_collision_returns_error_when_overwrite_false() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        save_into(&mut conn, 1, "skill", "first", GOOD_STEPS, false, 100).unwrap();
        let r = save_into(&mut conn, 1, "skill", "second", GOOD_STEPS, false, 200);
        assert_eq!(err_kind(&r.unwrap_err()), Some("name_collision"));
        // The live row is untouched.
        let desc: String = conn
            .query_row(
                "SELECT description FROM workflow_skills WHERE workflow_id=1 AND name='skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(desc, "first");
        // And no history row was written for this conflict.
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_skills_history WHERE workflow_id=1 AND name='skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn overwrite_pushes_old_row_to_history() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        let id1 = save_into(&mut conn, 1, "skill", "v1", GOOD_STEPS, false, 100).unwrap();
        let new_steps = r#"[{"tool":"fs_read","args":{"path":"/tmp/z"}}]"#;
        let id2 = save_into(&mut conn, 1, "skill", "v2", new_steps, true, 200).unwrap();
        // The id is stable across the in-place update.
        assert_eq!(id1, id2);
        // Live row reflects the new payload.
        let (desc, steps): (String, String) = conn
            .query_row(
                "SELECT description, steps_json FROM workflow_skills WHERE id=?1",
                params![id1],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(desc, "v2");
        assert_eq!(steps, new_steps);
        // History captured the old payload.
        let (hist_desc, hist_steps, when): (String, String, i64) = conn
            .query_row(
                "SELECT description, steps_json, overwrote_at FROM workflow_skills_history
                 WHERE workflow_id=1 AND name='skill'
                 ORDER BY overwrote_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(hist_desc, "v1");
        assert_eq!(hist_steps, GOOD_STEPS);
        assert_eq!(when, 200);
    }

    #[test]
    fn history_trims_at_50_per_skill() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        // Initial save.
        save_into(&mut conn, 1, "skill", "v0", GOOD_STEPS, false, 0).unwrap();
        // Overwrite 60 times → 60 history rows would accumulate without the
        // trim; with the cap only 50 survive.
        for i in 1..=60_i64 {
            let desc = format!("v{i}");
            save_into(&mut conn, 1, "skill", &desc, GOOD_STEPS, true, i).unwrap();
        }
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_skills_history WHERE workflow_id=1 AND name='skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, HISTORY_CAP_PER_SKILL);
        // The 10 oldest history descriptions (v0..v9) should have been trimmed,
        // leaving v10..v59 (the 50 most recent overwrites' *prior* values).
        // History row N captures the descriptionvalue PRESENT at the moment of
        // overwrite N — so the first overwrite (at ts=1) pushed "v0", the
        // 60th overwrite (at ts=60) pushed "v59". After trim, the surviving
        // descriptions are v10..v59 inclusive.
        let oldest_desc: String = conn
            .query_row(
                "SELECT description FROM workflow_skills_history
                 WHERE workflow_id=1 AND name='skill'
                 ORDER BY overwrote_at ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(oldest_desc, "v10");
        let newest_desc: String = conn
            .query_row(
                "SELECT description FROM workflow_skills_history
                 WHERE workflow_id=1 AND name='skill'
                 ORDER BY overwrote_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(newest_desc, "v59");
    }

    #[test]
    fn list_filters_by_workflow_id() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        insert_workflow(&conn, 2);
        save_into(&mut conn, 1, "alpha", "a", GOOD_STEPS, false, 100).unwrap();
        save_into(&mut conn, 1, "beta", "b", GOOD_STEPS, false, 101).unwrap();
        save_into(&mut conn, 2, "gamma", "g", GOOD_STEPS, false, 102).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM workflow_skills WHERE workflow_id = ?1 ORDER BY name ASC")
            .unwrap();
        let names_1: Vec<String> = stmt
            .query_map(params![1_i64], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(names_1, vec!["alpha", "beta"]);
        let names_2: Vec<String> = stmt
            .query_map(params![2_i64], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(names_2, vec!["gamma"]);
    }

    #[test]
    fn get_returns_none_for_missing() {
        let conn = fresh_db();
        // Mirror `get` directly so the test is pool-free.
        let row: Option<(i64,)> = conn
            .query_row(
                "SELECT id FROM workflow_skills WHERE workflow_id=1 AND name='nope'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .ok();
        assert!(row.is_none());
    }

    #[test]
    fn record_invocation_increments_count_and_updates_last_used_at() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        save_into(&mut conn, 1, "skill", "d", GOOD_STEPS, false, 100).unwrap();
        // Mirror `record_invocation` against the local connection.
        let bump = |ts: i64| {
            conn.execute(
                "UPDATE workflow_skills
                 SET invocation_count = invocation_count + 1, last_used_at = ?1
                 WHERE workflow_id = 1 AND name = 'skill'",
                params![ts],
            )
            .unwrap();
        };
        bump(500);
        bump(600);
        bump(700);
        let (count, last): (i64, Option<i64>) = conn
            .query_row(
                "SELECT invocation_count, last_used_at FROM workflow_skills
                 WHERE workflow_id=1 AND name='skill'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(last, Some(700));
        // Recording an invocation against a non-existent skill is a no-op,
        // never an error. The UPDATE affects 0 rows.
        let changed = conn
            .execute(
                "UPDATE workflow_skills
                 SET invocation_count = invocation_count + 1, last_used_at = ?1
                 WHERE workflow_id = 1 AND name = 'missing'",
                params![800_i64],
            )
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn delete_removes_row() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        save_into(&mut conn, 1, "skill", "d", GOOD_STEPS, false, 100).unwrap();
        conn.execute(
            "DELETE FROM workflow_skills WHERE workflow_id=1 AND name='skill'",
            [],
        )
        .unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_skills WHERE workflow_id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
        // Deleting an already-missing row is a no-op.
        let changed = conn
            .execute(
                "DELETE FROM workflow_skills WHERE workflow_id=1 AND name='missing'",
                [],
            )
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn cascade_deletes_when_workflow_deleted() {
        let mut conn = fresh_db();
        insert_workflow(&conn, 1);
        insert_workflow(&conn, 2);
        save_into(&mut conn, 1, "alpha", "a", GOOD_STEPS, false, 100).unwrap();
        save_into(&mut conn, 1, "beta", "b", GOOD_STEPS, false, 101).unwrap();
        save_into(&mut conn, 2, "gamma", "g", GOOD_STEPS, false, 102).unwrap();
        // FK cascade must drop workflow 1's skills.
        conn.execute("DELETE FROM workflows WHERE id=1", [])
            .unwrap();
        let n_wf1: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_skills WHERE workflow_id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_wf1, 0, "workflow 1 skills must cascade-delete");
        // Workflow 2's skill must survive.
        let n_wf2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workflow_skills WHERE workflow_id=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_wf2, 1, "workflow 2 skills must be unaffected");
    }
}
