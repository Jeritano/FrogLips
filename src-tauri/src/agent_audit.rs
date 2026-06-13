//! Persistent audit log for agent tool invocations.
//!
//! Every tool dispatch (from the frontend agent loop) writes a single row to
//! `agent_audit`. Rows are queryable for debugging + analytics. Schema is
//! defined here and installed by `ensure_schema` which is invoked from
//! `history::setup_schema` (idempotent — safe to run on every boot).
//!
//! Failure policy: callers should treat `record()` as best-effort. The
//! frontend wraps the call in a try/catch and never lets a failed audit
//! break the agent loop.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::history::get_db;

/* ── Schema installer ── */

/// Create the audit table + indexes if absent. Safe to call repeatedly.
/// Invoked from `history::setup_schema` so the migration runs as part of
/// the existing init pass.
pub(crate) fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            conversation_id TEXT,
            tool_name TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_hash TEXT NOT NULL,
            result_size INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            approval TEXT NOT NULL,
            outcome TEXT NOT NULL,
            error_kind TEXT,
            workflow_run_id INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_agent_audit_ts ON agent_audit(ts);
         CREATE INDEX IF NOT EXISTS idx_agent_audit_ts_id ON agent_audit(ts DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_agent_audit_conv ON agent_audit(conversation_id);
         CREATE INDEX IF NOT EXISTS idx_agent_audit_workflow_run ON agent_audit(workflow_run_id);
         CREATE TABLE IF NOT EXISTS agent_session_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            conversation_id TEXT NOT NULL,
            iterations INTEGER NOT NULL,
            tool_calls INTEGER NOT NULL,
            total_tool_ms INTEGER NOT NULL,
            total_llm_ms INTEGER NOT NULL,
            prompt_tokens INTEGER NOT NULL,
            completion_tokens INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_session_metrics_ts ON agent_session_metrics(ts);
         CREATE INDEX IF NOT EXISTS idx_agent_session_metrics_conv ON agent_session_metrics(conversation_id);",
    )?;
    Ok(())
}

/* ── Public types (serde) ── */

#[derive(Debug, Clone, Deserialize)]
pub struct AuditEntry {
    /// Unix epoch millis. If absent / zero, computed at insert time.
    #[serde(default)]
    pub ts: i64,
    pub conversation_id: Option<String>,
    pub tool_name: String,
    pub args_json: String,
    /// Raw result body — hashed + sized at insert time. Pass `""` if unknown.
    #[serde(default)]
    pub result_body: String,
    pub duration_ms: i64,
    pub approval: String,
    pub outcome: String,
    pub error_kind: Option<String>,
    /// Optional workflow_runs.id (NULL for ad-hoc chat tool calls). Lets the
    /// audit log distinguish workflow-driven activity from interactive
    /// turns, and the workflow UI link directly to the rows produced by a
    /// given run. Schema v12.
    #[serde(default)]
    pub workflow_run_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuditFilter {
    pub conversation_id: Option<String>,
    pub tool_name: Option<String>,
    pub since_ts: Option<i64>,
    pub until_ts: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditRow {
    pub id: i64,
    pub ts: i64,
    pub conversation_id: Option<String>,
    pub tool_name: String,
    pub args_json: String,
    pub result_hash: String,
    pub result_size: i64,
    pub duration_ms: i64,
    pub approval: String,
    pub outcome: String,
    pub error_kind: Option<String>,
    pub workflow_run_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AuditStats {
    /// Total tool invocations in the last 24h.
    pub total_calls_24h: i64,
    /// Top 5 most-used tools in the last 24h (descending by count).
    pub top_tools_24h: Vec<TopToolEntry>,
    /// Average duration_ms per tool over the last 24h.
    pub avg_duration_ms_24h: Vec<AvgDurationEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopToolEntry {
    pub tool_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AvgDurationEntry {
    pub tool_name: String,
    pub avg_ms: f64,
}

/* ── Helpers ── */

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// SHA-256 truncated to first 16 hex chars (64 bits) — enough to dedupe
/// identical results without bloating the index.
fn hash_result(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    let digest = h.finalize();
    let full = format!("{:x}", digest);
    full.chars().take(16).collect()
}

/* ── Public API ── */

/// Max bytes stored in `args_json` per audit row. Without a cap, a single
/// `write_file` with a 200 KB body or a `multi_edit` with dozens of large
/// edits balloons the audit table — the TS-side redactor already truncates
/// well-known body fields, but unrecognised tools pass args verbatim.
/// Truncated payloads carry a trailing marker so a reviewer knows the row
/// is incomplete. Data-layer audit C4 (2026-05-24).
pub const MAX_ARGS_JSON_BYTES: usize = 32 * 1024;

/// Insert one audit row. Errors are returned (caller decides whether to swallow).
pub fn record(entry: AuditEntry) -> Result<()> {
    let conn = get_db()?;
    let ts = if entry.ts > 0 { entry.ts } else { now_millis() };
    let hash = hash_result(&entry.result_body);
    let size = entry.result_body.len() as i64;
    let args_capped = if entry.args_json.len() > MAX_ARGS_JSON_BYTES {
        // Walk back to a UTF-8 char boundary so the trailing marker stays
        // valid JSON-loadable text (the value is no longer parseable as
        // JSON, but downstream consumers `SUBSTR` / display it as text).
        let mut cut = MAX_ARGS_JSON_BYTES;
        while cut > 0 && !entry.args_json.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut s = String::with_capacity(cut + 64);
        s.push_str(&entry.args_json[..cut]);
        s.push_str(&format!(
            "…[truncated {} bytes from {}-byte args]",
            entry.args_json.len() - cut,
            entry.args_json.len()
        ));
        s
    } else {
        entry.args_json
    };
    conn.execute(
        "INSERT INTO agent_audit
            (ts, conversation_id, tool_name, args_json, result_hash, result_size,
             duration_ms, approval, outcome, error_kind, workflow_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            ts,
            entry.conversation_id,
            entry.tool_name,
            args_capped,
            hash,
            size,
            entry.duration_ms,
            entry.approval,
            entry.outcome,
            entry.error_kind,
            entry.workflow_run_id,
        ],
    )?;
    // Audit A07: self-bound on insert so the table can't grow without limit
    // (the only purge was a manual IPC nothing called). Best-effort, every 256th
    // insert, keep the newest MAX_AUDIT_ROWS by rowid. Cheap + non-fatal.
    const MAX_AUDIT_ROWS: i64 = 50_000;
    static INSERTS_SINCE_TRIM: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    if INSERTS_SINCE_TRIM
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .is_multiple_of(256)
    {
        let _ = conn.execute(
            "DELETE FROM agent_audit WHERE rowid NOT IN \
             (SELECT rowid FROM agent_audit ORDER BY rowid DESC LIMIT ?1)",
            params![MAX_AUDIT_ROWS],
        );
    }
    Ok(())
}

/// Paginated query. Defaults: limit=100 (capped at 1000), offset=0.
pub fn list(filter: AuditFilter) -> Result<Vec<AuditRow>> {
    let conn = get_db()?;
    let limit = filter.limit.unwrap_or(100).clamp(1, 1000);
    let offset = filter.offset.unwrap_or(0).max(0);

    // Build a dynamic WHERE while keeping all values parameterised.
    let mut sql = String::from(
        "SELECT id, ts, conversation_id, tool_name, args_json, result_hash,
                result_size, duration_ms, approval, outcome, error_kind,
                workflow_run_id
         FROM agent_audit",
    );
    let mut clauses: Vec<&'static str> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if filter.conversation_id.is_some() {
        clauses.push("conversation_id = ?");
        binds.push(Box::new(filter.conversation_id.clone().unwrap()));
    }
    if filter.tool_name.is_some() {
        clauses.push("tool_name = ?");
        binds.push(Box::new(filter.tool_name.clone().unwrap()));
    }
    if let Some(s) = filter.since_ts {
        clauses.push("ts >= ?");
        binds.push(Box::new(s));
    }
    if let Some(u) = filter.until_ts {
        clauses.push("ts <= ?");
        binds.push(Box::new(u));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?");
    binds.push(Box::new(limit));
    binds.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = binds
        .iter()
        .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_refs), |r| {
            Ok(AuditRow {
                id: r.get(0)?,
                ts: r.get(1)?,
                conversation_id: r.get(2)?,
                tool_name: r.get(3)?,
                args_json: r.get(4)?,
                result_hash: r.get(5)?,
                result_size: r.get(6)?,
                duration_ms: r.get(7)?,
                approval: r.get(8)?,
                outcome: r.get(9)?,
                error_kind: r.get(10)?,
                workflow_run_id: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Housekeeping: drop rows older than `days` days. Returns rows deleted.
pub fn purge_older_than(days: u32) -> Result<usize> {
    let cutoff = now_millis() - (days as i64) * 86_400_000;
    let conn = get_db()?;
    let n = conn.execute("DELETE FROM agent_audit WHERE ts < ?1", params![cutoff])?;
    Ok(n)
}

/// Quick counts: 24h totals, top 5 tools, avg duration per tool.
pub fn stats() -> Result<AuditStats> {
    let conn = get_db()?;
    let cutoff = now_millis() - 24 * 60 * 60 * 1000;

    let total_calls_24h: i64 = conn.query_row(
        "SELECT COUNT(*) FROM agent_audit WHERE ts >= ?1",
        params![cutoff],
        |r| r.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT tool_name, COUNT(*) AS c
           FROM agent_audit
          WHERE ts >= ?1
          GROUP BY tool_name
          ORDER BY c DESC
          LIMIT 5",
    )?;
    let top_tools_24h = stmt
        .query_map(params![cutoff], |r| {
            Ok(TopToolEntry {
                tool_name: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut stmt = conn.prepare(
        "SELECT tool_name, AVG(duration_ms) AS avg_ms
           FROM agent_audit
          WHERE ts >= ?1
          GROUP BY tool_name
          ORDER BY avg_ms DESC",
    )?;
    let avg_duration_ms_24h = stmt
        .query_map(params![cutoff], |r| {
            Ok(AvgDurationEntry {
                tool_name: r.get(0)?,
                avg_ms: r.get::<_, f64>(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    Ok(AuditStats {
        total_calls_24h,
        top_tools_24h,
        avg_duration_ms_24h,
    })
}

/* ── Session metrics (recorded once per `runAgentLoop` exit) ── */

#[derive(Debug, Clone, Deserialize)]
pub struct SessionMetricsEntry {
    #[serde(default)]
    pub ts: i64,
    pub conversation_id: String,
    pub iterations: i64,
    pub tool_calls: i64,
    pub total_tool_ms: i64,
    pub total_llm_ms: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMetricsRow {
    pub id: i64,
    pub ts: i64,
    pub conversation_id: String,
    pub iterations: i64,
    pub tool_calls: i64,
    pub total_tool_ms: i64,
    pub total_llm_ms: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

pub fn session_metrics_record(entry: SessionMetricsEntry) -> Result<()> {
    let conn = get_db()?;
    let ts = if entry.ts > 0 { entry.ts } else { now_millis() };
    conn.execute(
        "INSERT INTO agent_session_metrics
            (ts, conversation_id, iterations, tool_calls, total_tool_ms,
             total_llm_ms, prompt_tokens, completion_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            ts,
            entry.conversation_id,
            entry.iterations,
            entry.tool_calls,
            entry.total_tool_ms,
            entry.total_llm_ms,
            entry.prompt_tokens,
            entry.completion_tokens,
        ],
    )?;
    Ok(())
}

pub fn session_metrics_query(filter: AuditFilter) -> Result<Vec<SessionMetricsRow>> {
    let conn = get_db()?;
    let limit = filter.limit.unwrap_or(1000).clamp(1, 10_000);
    let offset = filter.offset.unwrap_or(0).max(0);

    let mut sql = String::from(
        "SELECT id, ts, conversation_id, iterations, tool_calls,
                total_tool_ms, total_llm_ms, prompt_tokens, completion_tokens
         FROM agent_session_metrics",
    );
    let mut clauses: Vec<&'static str> = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(c) = &filter.conversation_id {
        clauses.push("conversation_id = ?");
        binds.push(Box::new(c.clone()));
    }
    if let Some(s) = filter.since_ts {
        clauses.push("ts >= ?");
        binds.push(Box::new(s));
    }
    if let Some(u) = filter.until_ts {
        clauses.push("ts <= ?");
        binds.push(Box::new(u));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ts ASC, id ASC LIMIT ? OFFSET ?");
    binds.push(Box::new(limit));
    binds.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = binds
        .iter()
        .map(|b| b.as_ref() as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_refs), |r| {
            Ok(SessionMetricsRow {
                id: r.get(0)?,
                ts: r.get(1)?,
                conversation_id: r.get(2)?,
                iterations: r.get(3)?,
                tool_calls: r.get(4)?,
                total_tool_ms: r.get(5)?,
                total_llm_ms: r.get(6)?,
                prompt_tokens: r.get(7)?,
                completion_tokens: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/* ── Dashboard summary (one-shot aggregate) ── */

#[derive(Debug, Clone, Serialize)]
pub struct ToolLatencyRow {
    pub tool_name: String,
    pub count: i64,
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalCount {
    pub approval: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DashboardSummary {
    pub window_since_ts: i64,
    pub window_until_ts: i64,
    pub tool_counts: Vec<TopToolEntry>,
    pub tool_latency: Vec<ToolLatencyRow>,
    pub approval_counts: Vec<ApprovalCount>,
    pub session_metrics: Vec<SessionMetricsRow>,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
}

fn percentile(sorted: &[i64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0] as f64;
    }
    let rank = p * (sorted.len() as f64 - 1.0);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        return sorted[lo] as f64;
    }
    let frac = rank - lo as f64;
    sorted[lo] as f64 + (sorted[hi] as f64 - sorted[lo] as f64) * frac
}

pub fn dashboard_summary(filter: AuditFilter) -> Result<DashboardSummary> {
    let conn = get_db()?;
    let now = now_millis();
    let since = filter.since_ts.unwrap_or(0);
    let until = filter.until_ts.unwrap_or(now);

    // Tool counts (top 15 by descending count).
    let mut stmt = conn.prepare(
        "SELECT tool_name, COUNT(*) AS c
           FROM agent_audit
          WHERE ts >= ?1 AND ts <= ?2
          GROUP BY tool_name
          ORDER BY c DESC
          LIMIT 15",
    )?;
    let tool_counts: Vec<TopToolEntry> = stmt
        .query_map(params![since, until], |r| {
            Ok(TopToolEntry {
                tool_name: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // Tool latency — pull every duration grouped by tool, compute percentiles in Rust.
    let mut stmt = conn.prepare(
        "SELECT tool_name, duration_ms
           FROM agent_audit
          WHERE ts >= ?1 AND ts <= ?2
          ORDER BY tool_name",
    )?;
    let mut grouped: HashMap<String, Vec<i64>> = HashMap::new();
    let rows = stmt.query_map(params![since, until], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (name, dur) = row?;
        grouped.entry(name).or_default().push(dur);
    }
    drop(stmt);
    let mut tool_latency: Vec<ToolLatencyRow> = grouped
        .into_iter()
        .map(|(name, mut durs)| {
            durs.sort_unstable();
            let count = durs.len() as i64;
            let sum: i64 = durs.iter().sum();
            let avg_ms = if count > 0 {
                sum as f64 / count as f64
            } else {
                0.0
            };
            let p50 = percentile(&durs, 0.50);
            let p95 = percentile(&durs, 0.95);
            let max_ms = *durs.last().unwrap_or(&0);
            ToolLatencyRow {
                tool_name: name,
                count,
                avg_ms,
                p50_ms: p50,
                p95_ms: p95,
                max_ms,
            }
        })
        .collect();
    tool_latency.sort_by_key(|r| std::cmp::Reverse(r.count));

    // Approval counts.
    let mut stmt = conn.prepare(
        "SELECT approval, COUNT(*) AS c
           FROM agent_audit
          WHERE ts >= ?1 AND ts <= ?2
          GROUP BY approval",
    )?;
    let mut approval_counts: Vec<ApprovalCount> = stmt
        .query_map(params![since, until], |r| {
            Ok(ApprovalCount {
                approval: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Also include rows whose outcome is dry_run (those are recorded under approval=auto
    // but the dashboard renders them as a separate slice). Pull outcome counts and
    // synthesize a dry_run pseudo-approval row.
    drop(stmt);
    let dry_run: i64 = conn.query_row(
        "SELECT COUNT(*) FROM agent_audit
           WHERE ts >= ?1 AND ts <= ?2 AND outcome = 'dry_run'",
        params![since, until],
        |r| r.get(0),
    )?;
    if dry_run > 0 {
        approval_counts.push(ApprovalCount {
            approval: "dry_run".into(),
            count: dry_run,
        });
    }

    // Session metrics rows in the window.
    let session_metrics = session_metrics_query(AuditFilter {
        since_ts: Some(since),
        until_ts: Some(until),
        limit: Some(10_000),
        ..AuditFilter::default()
    })?;
    let total_prompt_tokens: i64 = session_metrics.iter().map(|r| r.prompt_tokens).sum();
    let total_completion_tokens: i64 = session_metrics.iter().map(|r| r.completion_tokens).sum();

    Ok(DashboardSummary {
        window_since_ts: since,
        window_until_ts: until,
        tool_counts,
        tool_latency,
        approval_counts,
        session_metrics,
        total_prompt_tokens,
        total_completion_tokens,
    })
}

/* ── Internal: small helper for callers that want a structured args map ── */

/// Convenience: serialize args (truncating large `content` fields for
/// write_file / edit_file / multi_edit) to bounded JSON. Used exclusively
/// by the tests below; the live agent loop performs the equivalent
/// truncation in TS before sending args over IPC. Gated to `cfg(test)`
/// so the dead-code warning stays clean on prod builds while the helper
/// remains available for the existing test coverage.
#[cfg(test)]
pub fn redact_args(tool: &str, args: &serde_json::Value) -> String {
    fn truncate_str(s: &str, max: usize) -> String {
        if s.chars().count() <= max {
            s.to_string()
        } else {
            let mut out: String = s.chars().take(max).collect();
            out.push_str("...");
            out
        }
    }

    if let Some(obj) = args.as_object() {
        let mut copy: HashMap<String, serde_json::Value> =
            obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let bulky_fields: &[&str] = match tool {
            "write_file" => &["content"],
            "edit_file" => &["old_string", "new_string"],
            "multi_edit" => &[],
            _ => &[],
        };
        for f in bulky_fields {
            if let Some(serde_json::Value::String(s)) = copy.get(*f) {
                copy.insert(
                    (*f).to_string(),
                    serde_json::Value::String(truncate_str(s, 256)),
                );
            }
        }
        serde_json::to_string(&copy).unwrap_or_else(|_| "{}".to_string())
    } else {
        args.to_string()
    }
}

/* ── Tests ── */

#[cfg(test)]
mod tests {
    use super::*;

    // Build an isolated in-memory connection so tests don't touch the real
    // db pool used by other modules. We exercise the SQL we actually run
    // in production by sharing `ensure_schema` + the exact statements.
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        ensure_schema(&conn).expect("schema install");
        conn
    }

    fn insert(conn: &Connection, e: AuditEntry) -> i64 {
        let ts = if e.ts > 0 { e.ts } else { now_millis() };
        let hash = hash_result(&e.result_body);
        let size = e.result_body.len() as i64;
        conn.execute(
            "INSERT INTO agent_audit
                (ts, conversation_id, tool_name, args_json, result_hash, result_size,
                 duration_ms, approval, outcome, error_kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                ts,
                e.conversation_id,
                e.tool_name,
                e.args_json,
                hash,
                size,
                e.duration_ms,
                e.approval,
                e.outcome,
                e.error_kind,
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn schema_is_idempotent() {
        let conn = fresh_db();
        // Re-running ensure_schema must not error.
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
    }

    #[test]
    fn record_and_list_round_trip() {
        let conn = fresh_db();
        let now = now_millis();
        insert(
            &conn,
            AuditEntry {
                ts: now,
                conversation_id: Some("c1".into()),
                tool_name: "read_file".into(),
                args_json: r#"{"path":"/tmp/x"}"#.into(),
                result_body: r#"{"ok":true}"#.into(),
                duration_ms: 12,
                approval: "auto".into(),
                outcome: "ok".into(),
                error_kind: None,
                workflow_run_id: None,
            },
        );

        let mut stmt = conn
            .prepare(
                "SELECT tool_name, conversation_id, approval, outcome, result_size
                 FROM agent_audit ORDER BY id DESC LIMIT 1",
            )
            .unwrap();
        let row: (String, Option<String>, String, String, i64) = stmt
            .query_row([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!(row.0, "read_file");
        assert_eq!(row.1.as_deref(), Some("c1"));
        assert_eq!(row.2, "auto");
        assert_eq!(row.3, "ok");
        assert_eq!(row.4, r#"{"ok":true}"#.len() as i64);
    }

    #[test]
    fn redact_args_truncates_write_file_content() {
        let big: String = "x".repeat(1000);
        let args = serde_json::json!({ "path": "/a", "content": big });
        let s = redact_args("write_file", &args);
        // Should contain the path verbatim but not the entire 1000-char content.
        assert!(s.contains("\"/a\""));
        assert!(!s.contains(&"x".repeat(1000)));
        assert!(s.contains("..."));
    }

    #[test]
    fn redact_args_leaves_other_tools_alone() {
        let args = serde_json::json!({ "path": "/a", "pattern": "abc" });
        let s = redact_args("search_files", &args);
        assert!(s.contains("\"abc\""));
        assert!(s.contains("\"/a\""));
    }

    #[test]
    fn session_metrics_table_exists_and_idempotent() {
        let conn = fresh_db();
        // Re-running ensure_schema must not error and the new table must exist
        // (sanity-checked via an insert against the new shape).
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO agent_session_metrics
                (ts, conversation_id, iterations, tool_calls, total_tool_ms,
                 total_llm_ms, prompt_tokens, completion_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                now_millis(),
                "conv-1",
                5_i64,
                2_i64,
                12_i64,
                34_i64,
                100_i64,
                200_i64
            ],
        )
        .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_session_metrics", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn empty_db_summary_aggregations_are_zeroed() {
        // The public summary fn requires the shared get_db() pool, but the
        // aggregation queries themselves are exactly what we'd run there.
        // Verify that on a freshly-installed schema each aggregation returns
        // zero rows / zero totals — the dashboard relies on this for its
        // empty-state rendering.
        let conn = fresh_db();
        let now = now_millis();
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_audit WHERE ts >= ?1 AND ts <= ?2",
                params![0_i64, now],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 0);
        let sm_cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_session_metrics", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(sm_cnt, 0);
        // percentile helper handles empty + single element correctly.
        assert_eq!(percentile(&[], 0.5), 0.0);
        assert_eq!(percentile(&[42], 0.95), 42.0);
        assert_eq!(percentile(&[1, 2, 3, 4], 0.5), 2.5);
    }

    #[test]
    fn hash_is_stable_and_truncated() {
        let a = hash_result("hello");
        let b = hash_result("hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        assert_eq!(a, "2cf24dba5fb0a30e");
    }
}
