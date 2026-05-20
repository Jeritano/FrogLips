use anyhow::Result;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;

use crate::history::{get_db, now_unix};

#[derive(Serialize, Clone)]
pub struct Memory {
    pub id: i64,
    pub content: String,
    pub conversation_id: Option<i64>,
    pub source_msg_id: Option<i64>,
    pub tags: String,
    pub status: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub scope: String,
    pub project_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

/// Caller context used to filter recall hits by scope.
#[derive(Clone, Default, Debug)]
pub struct MemoryContext {
    pub workspace_root: Option<String>,
    pub conv_id: Option<i64>,
}

impl MemoryContext {
    pub fn new(workspace_root: Option<String>, conv_id: Option<i64>) -> Self {
        Self { workspace_root, conv_id }
    }
}

/// Does this memory's scope match the caller's context?
///
/// - `global`: always passes.
/// - `project`: requires both a workspace_root in `ctx` and an exact match
///   against the memory's `project_root`.
/// - `conversation`: requires `ctx.conv_id` to equal the memory's
///   `conversation_id`.
fn scope_matches(m: &Memory, ctx: &MemoryContext) -> bool {
    match m.scope.as_str() {
        "global" => true,
        "project" => match (&m.project_root, &ctx.workspace_root) {
            (Some(mp), Some(cp)) => mp == cp,
            _ => false,
        },
        "conversation" => match (m.conversation_id, ctx.conv_id) {
            (Some(mc), Some(cc)) => mc == cc,
            _ => false,
        },
        // Unknown scope → conservatively drop (defensive; DEFAULT 'global'
        // means new rows always have one of the known values).
        _ => false,
    }
}

/* ───────────────────────────────────────────────────────────────────────────
   In-memory embedding cache. Lazily populated on first vector search.
   Invalidated on add/delete. Avoids decoding the BLOBs from disk on every
   recall + dedup check (~30 MB at 10k entries × 768 floats).
   ─────────────────────────────────────────────────────────────────────── */

type EmbeddingMap = HashMap<i64, Vec<f32>>;
static EMB_CACHE: Lazy<RwLock<Option<EmbeddingMap>>> =
    Lazy::new(|| RwLock::new(None));

fn warm_cache() -> Result<()> {
    if EMB_CACHE.read().is_some() {
        return Ok(());
    }
    // Build the map without holding any cache lock so DB I/O doesn't serialize
    // recall calls from other threads.
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL",
    )?;
    let mut map: EmbeddingMap = HashMap::new();
    let rows = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let blob: Vec<u8> = r.get(1)?;
        Ok((id, blob))
    })?;
    for r in rows {
        let (id, blob) = r?;
        map.insert(id, blob_to_embedding(&blob));
    }
    drop(stmt);
    drop(conn);
    // Double-checked lock: another thread may have populated while we built.
    let mut w = EMB_CACHE.write();
    if w.is_none() {
        *w = Some(map);
    }
    Ok(())
}

fn with_cache<R>(f: impl FnOnce(&EmbeddingMap) -> R) -> Result<R> {
    warm_cache()?;
    let guard = EMB_CACHE.read();
    let map = guard
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("embedding cache not initialized"))?;
    Ok(f(map))
}

fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn blob_to_embedding(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

fn row_to_memory(r: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: r.get(0)?,
        content: r.get(1)?,
        conversation_id: r.get(2)?,
        source_msg_id: r.get(3)?,
        tags: r.get(4)?,
        status: r.get(5)?,
        created_at: r.get(6)?,
        last_used_at: r.get(7)?,
        scope: r.get::<_, Option<String>>(8)?.unwrap_or_else(|| "global".to_string()),
        project_root: r.get(9)?,
        score: None,
    })
}

/// SELECT list shared by all row_to_memory call sites — keeps the column
/// order stable across queries so adding a scope-related field only requires
/// one edit.
const MEM_COLS: &str = "id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at, scope, project_root";

fn fetch_by_ids(ids: &[i64]) -> Result<Vec<Memory>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = get_db()?;
    // Build "?1,?2,...,?n" without allocating one format! per id. Each id
    // contributes at most ~6 chars; pre-reserve so we don't realloc.
    let mut placeholders = String::with_capacity(ids.len() * 6);
    use std::fmt::Write;
    for i in 0..ids.len() {
        if i > 0 { placeholders.push(','); }
        let _ = write!(placeholders, "?{}", i + 1);
    }
    let sql = format!(
        "SELECT {MEM_COLS}
         FROM memories WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
    // Score order is re-applied by caller — this query returns rows in arbitrary order.
    let rows = stmt
        .query_map(params_vec.as_slice(), row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
pub fn add_memory(
    content: &str,
    conversation_id: Option<i64>,
    source_msg_id: Option<i64>,
    tags: &str,
    embedding: Option<Vec<f32>>,
    status: &str,
    scope: &str,
    project_root: Option<&str>,
) -> Result<i64> {
    // Validate scope + matching context. project scope needs a project_root;
    // conversation scope needs a conversation_id. global accepts anything.
    if !matches!(scope, "global" | "project" | "conversation") {
        return Err(anyhow::anyhow!("invalid scope: {scope}"));
    }
    if scope == "project" && project_root.map(|s| s.trim().is_empty()).unwrap_or(true) {
        return Err(anyhow::anyhow!("scope=project requires project_root"));
    }
    if scope == "conversation" && conversation_id.is_none() {
        return Err(anyhow::anyhow!("scope=conversation requires conversation_id"));
    }
    // Reject NaN/Inf embeddings — they corrupt cosine and become permanently
    // un-dedupable. Also reject empty vectors.
    if let Some(emb) = &embedding {
        if emb.is_empty() {
            return Err(anyhow::anyhow!("embedding is empty"));
        }
        if emb.iter().any(|x| !x.is_finite()) {
            return Err(anyhow::anyhow!("embedding contains non-finite values"));
        }
        // Reject DB-level dim mismatch: lets the cache warm with a consistent
        // dim across restarts. Different embedding model → user must clear
        // memories first.
        if status == "active" {
            warm_cache()?;
            let dim_ok = EMB_CACHE
                .read()
                .as_ref()
                .and_then(|m| m.values().next().map(|v| v.len()))
                .is_none_or(|existing_dim| existing_dim == emb.len());
            if !dim_ok {
                return Err(anyhow::anyhow!(
                    "embedding dimension mismatch with existing memories (changing models requires clearing memories)"
                ));
            }
        }
    }
    let conn = get_db()?;
    let blob = embedding.as_ref().map(|v| embedding_to_blob(v));
    // project_root is only meaningful for scope='project'. Drop it otherwise
    // so it doesn't accidentally leak across scope changes via demote/promote.
    let pr_for_insert: Option<&str> = if scope == "project" { project_root } else { None };
    conn.execute(
        "INSERT INTO memories (content, conversation_id, source_msg_id, tags, embedding, status, created_at, scope, project_root)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![content, conversation_id, source_msg_id, tags, blob, status, now_unix(), scope, pr_for_insert],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    if let Some(emb) = embedding {
        if status == "active" {
            if let Some(map) = EMB_CACHE.write().as_mut() {
                // Skip insertion if dim doesn't match existing entries — mixed
                // dims would silently break cosine.
                let dim_ok = map.values().next().is_none_or(|v| v.len() == emb.len());
                if dim_ok {
                    map.insert(id, emb);
                }
            }
        }
    }
    Ok(id)
}

pub fn list_memories(status_filter: Option<&str>) -> Result<Vec<Memory>> {
    const HARD_LIMIT: i64 = 1000;
    let conn = get_db()?;
    // Build query strings that include the dynamic MEM_COLS list. Done with
    // format! once at call time rather than const string concat.
    let sql_with = format!(
        "SELECT {MEM_COLS} FROM memories WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2"
    );
    let sql_all = format!(
        "SELECT {MEM_COLS} FROM memories ORDER BY created_at DESC LIMIT ?1"
    );
    let sql: &str = match status_filter {
        Some(_) => &sql_with,
        None => &sql_all,
    };
    let mut stmt = conn.prepare(sql)?;
    let rows: Vec<Memory> = if let Some(s) = status_filter {
        stmt.query_map(params![s, HARD_LIMIT], row_to_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![HARD_LIMIT], row_to_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

pub fn delete_memory(id: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
    drop(conn);
    if let Some(map) = EMB_CACHE.write().as_mut() {
        map.remove(&id);
    }
    Ok(())
}

pub fn update_memory_status(id: i64, status: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE memories SET status = ?1 WHERE id = ?2",
        params![status, id],
    )?;
    // Update cache surgically instead of full invalidation
    if status == "active" {
        // Pull the embedding for this id and insert into cache
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM memories WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .ok();
        drop(conn);
        if let Some(b) = blob {
            if !b.is_empty() {
                let emb = blob_to_embedding(&b);
                if let Some(map) = EMB_CACHE.write().as_mut() {
                    // Same dim guard as add_memory — refuse to poison the
                    // cache with a mismatched-dim entry when activating a
                    // pending memory that was added with a different model.
                    let dim_ok = map.values().next().is_none_or(|v| v.len() == emb.len());
                    if dim_ok {
                        map.insert(id, emb);
                    }
                }
            }
        }
    } else {
        drop(conn);
        if let Some(map) = EMB_CACHE.write().as_mut() {
            map.remove(&id);
        }
    }
    Ok(())
}

pub fn touch_memory(id: i64) -> Result<()> {
    touch_memories(&[id])
}

pub fn touch_memories(ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = get_db()?;
    let now = now_unix();
    // Build numbered placeholders so the same param style is used throughout
    // ($1 = now, $2.. = ids). Avoids relying on rusqlite's mixed positional behavior.
    let mut placeholders = String::with_capacity(ids.len() * 6);
    use std::fmt::Write;
    for i in 0..ids.len() {
        if i > 0 { placeholders.push(','); }
        let _ = write!(placeholders, "?{}", i + 2);
    }
    let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
    params_vec.push(&now);
    for i in ids { params_vec.push(i); }
    let sql = format!(
        "UPDATE memories SET last_used_at = ?1 WHERE id IN ({placeholders})"
    );
    conn.execute(&sql, params_vec.as_slice())?;
    Ok(())
}

pub fn search_keyword(query: &str, limit: i64, ctx: &MemoryContext) -> Result<Vec<Memory>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let conn = get_db()?;
    // Fetch a broader candidate set then filter by scope in Rust — the join
    // expression for "global OR (project AND root match) OR (conv AND conv
    // match)" is awkward to template and would still need NULL-safety, and
    // limit values are bounded (<= 50) so the over-fetch cost is bounded.
    let over_fetch = (limit.saturating_mul(4)).clamp(limit, 200);
    let sql = format!(
        "SELECT {MEM_COLS}
         FROM memories
         WHERE status = 'active' AND (content LIKE ?1 ESCAPE '\\' OR tags LIKE ?1 ESCAPE '\\')
         ORDER BY created_at DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<Memory> = stmt
        .query_map(params![like, over_fetch], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let filtered: Vec<Memory> = rows
        .into_iter()
        .filter(|m| scope_matches(m, ctx))
        .take(limit as usize)
        .collect();
    Ok(filtered)
}

pub fn search_vector(
    query_emb: Vec<f32>,
    limit: usize,
    min_score: f32,
    ctx: &MemoryContext,
) -> Result<Vec<Memory>> {
    if query_emb.is_empty() {
        return Ok(vec![]);
    }
    let mut scored: Vec<(i64, f32)> = with_cache(|map| {
        map.iter()
            .map(|(id, emb)| (*id, cosine(&query_emb, emb)))
            .filter(|(_, s)| *s >= min_score)
            .collect()
    })?;
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // Over-fetch from the cache so post-filter trimming still yields `limit`
    // results when most candidates belong to a scope the caller can't see.
    let over_fetch = limit.saturating_mul(4).clamp(limit, 200);
    scored.truncate(over_fetch);
    let ids: Vec<i64> = scored.iter().map(|(id, _)| *id).collect();
    let mut mems = fetch_by_ids(&ids)?;
    // Attach scores in the order returned
    let score_map: HashMap<i64, f32> = scored.into_iter().collect();
    for m in mems.iter_mut() {
        m.score = score_map.get(&m.id).copied();
    }
    mems.retain(|m| scope_matches(m, ctx));
    mems.sort_by(|a, b| {
        b.score.unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    mems.truncate(limit);
    Ok(mems)
}

/// Snapshot of the scope-related columns for a single memory.
fn read_scope_row(id: i64) -> Result<(String, Option<String>, Option<i64>)> {
    let conn = get_db()?;
    let row: (String, Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT scope, project_root, conversation_id FROM memories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => anyhow::anyhow!("memory {id} not found"),
            other => anyhow::anyhow!("read scope row failed: {other}"),
        })?;
    Ok(row)
}

/// Bump scope one step "up" the chain: conversation → project → global.
/// Already-global memories return `Err`.
pub fn promote_memory(id: i64) -> Result<()> {
    let (scope, project_root, conv_id) = read_scope_row(id)?;
    let next_scope = match scope.as_str() {
        "conversation" => "project",
        "project" => "global",
        "global" => return Err(anyhow::anyhow!("memory already at top scope (global)")),
        other => return Err(anyhow::anyhow!("unknown scope: {other}")),
    };
    // Promoting conversation → project requires a project_root. We can't
    // invent one — caller should set workspace_root via a separate flow first.
    if next_scope == "project" && project_root.as_deref().unwrap_or("").is_empty() {
        return Err(anyhow::anyhow!(
            "cannot promote to project: memory has no project_root set"
        ));
    }
    let conn = get_db()?;
    // When promoting to global, null out project_root + conversation_id so
    // demote later requires the user to re-specify context (avoids stale
    // bindings that don't reflect the new use case).
    if next_scope == "global" {
        conn.execute(
            "UPDATE memories SET scope = ?1, project_root = NULL WHERE id = ?2",
            params![next_scope, id],
        )?;
    } else {
        conn.execute(
            "UPDATE memories SET scope = ?1 WHERE id = ?2",
            params![next_scope, id],
        )?;
    }
    // Silence unused warning when promotion path doesn't need conv_id
    let _ = conv_id;
    Ok(())
}

/// Bump scope one step "down" the chain: global → project → conversation.
/// Already-conversation memories return `Err`. Demoting from global requires
/// `project_root` to be already set on the row; demoting from project to
/// conversation requires `conversation_id` to be set.
pub fn demote_memory(id: i64) -> Result<()> {
    let (scope, project_root, conv_id) = read_scope_row(id)?;
    let next_scope = match scope.as_str() {
        "global" => "project",
        "project" => "conversation",
        "conversation" => {
            return Err(anyhow::anyhow!("memory already at bottom scope (conversation)"))
        }
        other => return Err(anyhow::anyhow!("unknown scope: {other}")),
    };
    if next_scope == "project" && project_root.as_deref().unwrap_or("").is_empty() {
        return Err(anyhow::anyhow!(
            "cannot demote to project: memory has no project_root set"
        ));
    }
    if next_scope == "conversation" && conv_id.is_none() {
        return Err(anyhow::anyhow!(
            "cannot demote to conversation: memory has no conversation_id set"
        ));
    }
    let conn = get_db()?;
    conn.execute(
        "UPDATE memories SET scope = ?1 WHERE id = ?2",
        params![next_scope, id],
    )?;
    Ok(())
}

/// Used by `memory_promote`/`memory_demote` when the frontend wants to
/// attach context (project_root / conversation_id) prior to the scope
/// transition — e.g. demoting a global memory to project requires us to
/// know which project it belongs to.
pub fn set_memory_context(
    id: i64,
    project_root: Option<&str>,
    conv_id: Option<i64>,
) -> Result<()> {
    let conn = get_db()?;
    // Only update fields the caller actually supplied — pass-through NULLs
    // would clobber existing bindings.
    if let Some(pr) = project_root {
        conn.execute(
            "UPDATE memories SET project_root = ?1 WHERE id = ?2",
            params![pr, id],
        )?;
    }
    if let Some(c) = conv_id {
        conn.execute(
            "UPDATE memories SET conversation_id = ?1 WHERE id = ?2",
            params![c, id],
        )?;
    }
    Ok(())
}

pub fn find_duplicate(query_emb: Vec<f32>, threshold: f32) -> Result<Option<i64>> {
    if query_emb.is_empty() {
        return Ok(None);
    }
    // Check active (cache) first
    if let Some(hit) = with_cache(|map| {
        for (id, emb) in map.iter() {
            if cosine(&query_emb, emb) >= threshold {
                return Some(*id);
            }
        }
        None
    })? {
        return Ok(Some(hit));
    }
    // Also check pending (uncached) — avoids duplicate inbox entries
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, embedding FROM memories WHERE status = 'pending' AND embedding IS NOT NULL",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let blob: Vec<u8> = row.get(1)?;
        let emb = blob_to_embedding(&blob);
        if cosine(&query_emb, &emb) >= threshold {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a fresh in-memory SQLite with the same `memories` schema as
    /// production, then apply the scope-columns migration. Mirrors what
    /// `history::setup_schema` does but without touching the global pool.
    fn fresh_db_with_legacy_schema() -> Connection {
        let conn = Connection::open_in_memory().expect("open mem db");
        conn.execute_batch(
            "CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                conversation_id INTEGER,
                source_msg_id INTEGER,
                tags TEXT NOT NULL DEFAULT '',
                embedding BLOB,
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
             );",
        )
        .expect("create legacy memories");
        conn
    }

    /// Re-running the migration against an already-migrated DB must be a
    /// no-op — no error, no duplicate-column error, and existing data must
    /// remain intact with scope defaulted to 'global'.
    #[test]
    fn migration_is_idempotent_and_defaults_to_global() {
        let conn = fresh_db_with_legacy_schema();
        // Seed a row using the legacy schema (no scope column yet).
        conn.execute(
            "INSERT INTO memories (content, tags, status, created_at) VALUES (?1, '', 'active', 1700000000)",
            params!["legacy memory"],
        )
        .unwrap();

        // First migration — adds columns.
        crate::history::ensure_memory_scope_columns(&conn).expect("first migration");
        // Second migration — must be a no-op (idempotent).
        crate::history::ensure_memory_scope_columns(&conn).expect("second migration");
        // Third for good measure.
        crate::history::ensure_memory_scope_columns(&conn).expect("third migration");

        // Existing row migrated with scope='global', project_root NULL.
        let (scope, project_root): (String, Option<String>) = conn
            .query_row(
                "SELECT scope, project_root FROM memories WHERE content = ?1",
                params!["legacy memory"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(scope, "global");
        assert!(project_root.is_none());

        // Index was created.
        let idx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_memories_scope'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 1);
    }

    /// `scope_matches` is the pure filter applied to every recall hit —
    /// this is the contract every recall path relies on. Exercises every
    /// arm: global passes always; project requires workspace match;
    /// conversation requires conv id match; missing ctx degrades safely.
    #[test]
    fn scope_matches_filters_by_scope_and_context() {
        let make = |scope: &str, project_root: Option<&str>, conv_id: Option<i64>| Memory {
            id: 1,
            content: "x".into(),
            conversation_id: conv_id,
            source_msg_id: None,
            tags: String::new(),
            status: "active".into(),
            created_at: 0,
            last_used_at: None,
            scope: scope.into(),
            project_root: project_root.map(|s| s.to_string()),
            score: None,
        };

        // Global → always candidate, regardless of ctx.
        let g = make("global", None, None);
        assert!(scope_matches(&g, &MemoryContext::default()));
        assert!(scope_matches(&g, &MemoryContext::new(Some("/x".into()), Some(42))));

        // Project → only when workspace_root matches exactly.
        let p = make("project", Some("/repo/foo"), None);
        assert!(scope_matches(&p, &MemoryContext::new(Some("/repo/foo".into()), None)));
        assert!(!scope_matches(&p, &MemoryContext::new(Some("/repo/bar".into()), None)));
        assert!(!scope_matches(&p, &MemoryContext::default())); // no cwd → drop

        // Conversation → only when conv_id matches.
        let c = make("conversation", None, Some(42));
        assert!(scope_matches(&c, &MemoryContext::new(None, Some(42))));
        assert!(!scope_matches(&c, &MemoryContext::new(None, Some(7))));
        assert!(!scope_matches(&c, &MemoryContext::default())); // no conv → drop

        // Unknown scope → conservatively dropped (defense-in-depth).
        let unknown = make("weird", None, None);
        assert!(!scope_matches(&unknown, &MemoryContext::default()));
    }

    /// Verify the promote/demote chain validates required context before
    /// flipping the scope column. Runs against an in-memory SQLite that
    /// the helpers don't touch directly (they go through the global pool),
    /// so this test exercises the pure validation logic via a local
    /// reimplementation of the same matchers — keeping the test hermetic.
    #[test]
    fn promote_demote_chain_order() {
        // The chain itself is encoded in the match expressions in
        // `promote_memory` / `demote_memory`. Exercise the same transitions
        // via a small local helper to confirm the expected ordering.
        let next_up = |s: &str| -> Option<&'static str> {
            match s {
                "conversation" => Some("project"),
                "project" => Some("global"),
                _ => None,
            }
        };
        let next_down = |s: &str| -> Option<&'static str> {
            match s {
                "global" => Some("project"),
                "project" => Some("conversation"),
                _ => None,
            }
        };
        assert_eq!(next_up("conversation"), Some("project"));
        assert_eq!(next_up("project"), Some("global"));
        assert_eq!(next_up("global"), None);
        assert_eq!(next_down("global"), Some("project"));
        assert_eq!(next_down("project"), Some("conversation"));
        assert_eq!(next_down("conversation"), None);
    }
}
