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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

/* ───────────────────────────────────────────────────────────────────────────
   In-memory embedding cache. Lazily populated on first vector search.
   Invalidated on add/delete. Avoids decoding the BLOBs from disk on every
   recall + dedup check (~30 MB at 10k entries × 768 floats).
   ─────────────────────────────────────────────────────────────────────── */

static EMB_CACHE: Lazy<RwLock<Option<HashMap<i64, Vec<f32>>>>> =
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
    let mut map: HashMap<i64, Vec<f32>> = HashMap::new();
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

fn with_cache<R>(f: impl FnOnce(&HashMap<i64, Vec<f32>>) -> R) -> Result<R> {
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
        score: None,
    })
}

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
        "SELECT id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at
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

pub fn add_memory(
    content: &str,
    conversation_id: Option<i64>,
    source_msg_id: Option<i64>,
    tags: &str,
    embedding: Option<Vec<f32>>,
    status: &str,
) -> Result<i64> {
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
                .map_or(true, |existing_dim| existing_dim == emb.len());
            if !dim_ok {
                return Err(anyhow::anyhow!(
                    "embedding dimension mismatch with existing memories (changing models requires clearing memories)"
                ));
            }
        }
    }
    let conn = get_db()?;
    let blob = embedding.as_ref().map(|v| embedding_to_blob(v));
    conn.execute(
        "INSERT INTO memories (content, conversation_id, source_msg_id, tags, embedding, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![content, conversation_id, source_msg_id, tags, blob, status, now_unix()],
    )?;
    let id = conn.last_insert_rowid();
    drop(conn);
    if let Some(emb) = embedding {
        if status == "active" {
            if let Some(map) = EMB_CACHE.write().as_mut() {
                // Skip insertion if dim doesn't match existing entries — mixed
                // dims would silently break cosine.
                let dim_ok = map.values().next().map_or(true, |v| v.len() == emb.len());
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
    let sql = match status_filter {
        Some(_) => "SELECT id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at
                    FROM memories WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2",
        None => "SELECT id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at
                 FROM memories ORDER BY created_at DESC LIMIT ?1",
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
                    let dim_ok = map.values().next().map_or(true, |v| v.len() == emb.len());
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

pub fn search_keyword(query: &str, limit: i64) -> Result<Vec<Memory>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at
         FROM memories
         WHERE status = 'active' AND (content LIKE ?1 ESCAPE '\\' OR tags LIKE ?1 ESCAPE '\\')
         ORDER BY created_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![like, limit], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn search_vector(query_emb: Vec<f32>, limit: usize, min_score: f32) -> Result<Vec<Memory>> {
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
    scored.truncate(limit);
    let ids: Vec<i64> = scored.iter().map(|(id, _)| *id).collect();
    let mut mems = fetch_by_ids(&ids)?;
    // Attach scores in the order returned
    let score_map: HashMap<i64, f32> = scored.into_iter().collect();
    for m in mems.iter_mut() {
        m.score = score_map.get(&m.id).copied();
    }
    mems.sort_by(|a, b| {
        b.score.unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(mems)
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
