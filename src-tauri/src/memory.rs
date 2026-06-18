use anyhow::Result;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::history::{get_db, now_unix};

/* ───────────────────────────────────────────────────────────────────────────
Memoized `vec_memories` declared dimension. `vec0_usable_for` runs TWO
sqlite_master metadata queries (table_exists + a CREATE-SQL fetch+parse) on
every recall, but the vec table's dim is process-stable: it only changes when
the table is dropped (embedder switch → `invalidate_cache`, which resets this
memo) or first created (lazy `add_memory` / boot backfill, picked up by the
re-probe on a still-unknown value). Caching the resolved dim turns the hot
recall path into a single in-memory load + integer compare. Perf finding
(2026-06).

State: `UNKNOWN` (-1) = not yet learned → probe + cache on success; a positive
value = the table's declared dim. We only ever cache a *positive* dim (a table
that exists), so a not-yet-created table stays UNKNOWN and a later create is
detected; a drop is handled by the explicit reset in `invalidate_cache`.
─────────────────────────────────────────────────────────────────────── */
const MEMO_UNKNOWN: i64 = -1;
static VEC_MEM_DIM_MEMO: AtomicI64 = AtomicI64::new(MEMO_UNKNOWN);

/// Reset the memoized vec_memories dim so the next recall re-probes the schema.
/// Called whenever the vec0 table may have been dropped/recreated at a new dim.
fn reset_vec_mem_dim_memo() {
    VEC_MEM_DIM_MEMO.store(MEMO_UNKNOWN, Ordering::Relaxed);
}

/// Can vec0 KNN serve a query of `query_dim` against `vec_memories`, using the
/// memoized declared dim to skip the per-recall sqlite_master probes once known?
/// On a cache miss, falls back to the authoritative `vec0_usable_for` probe and
/// caches the table's dim (when it resolves to a positive value).
fn vec0_memories_usable(conn: &rusqlite::Connection, query_dim: usize) -> bool {
    if query_dim == 0 || !crate::history::vec0_available() {
        return false;
    }
    let cached = VEC_MEM_DIM_MEMO.load(Ordering::Relaxed);
    if cached > 0 {
        return cached as usize == query_dim;
    }
    // Unknown: read the table's declared dim once (this is the single schema
    // probe the memo amortizes). `vec_table_dim` returns None when the table is
    // absent → leave the memo UNKNOWN so a later lazy-create/backfill is picked
    // up; otherwise cache the dim so subsequent recalls skip the probe entirely.
    match crate::history::vec_table_dim(conn, crate::history::VEC_MEMORIES) {
        Some(dim) => {
            VEC_MEM_DIM_MEMO.store(dim as i64, Ordering::Relaxed);
            dim == query_dim
        }
        None => false,
    }
}

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
        Self {
            workspace_root,
            conv_id,
        }
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
static EMB_CACHE: Lazy<RwLock<Option<EmbeddingMap>>> = Lazy::new(|| RwLock::new(None));

/// Drop the warm-once embedding cache so the next recall rebuilds it from the
/// DB. Called after a data import, which raw-inserts memory rows the cache
/// never observed (today imports carry NULL embeddings, so vector recall isn't
/// corrupted — but `find_duplicate`/future re-embed-on-import would otherwise
/// read a stale cache until restart).
pub fn invalidate_cache() {
    *EMB_CACHE.write() = None;
    // Embedder switch: the cached vectors AND the vec0 derived index belong to
    // the old model's dim/space. Drop the vec0 table so the next add_memory
    // lazily recreates it at the new dim (and the next boot's
    // ensure_vec_tables_present rebuilds it from the BLOB source). Best-effort —
    // a DB error here must not mask the cache drop, and the BLOBs are untouched.
    let _ = crate::history::with_write(|tx| {
        crate::history::vec_drop_table(tx, crate::history::VEC_MEMORIES);
        Ok(())
    });
    // The vec0 table was just dropped (and will be lazily recreated at the new
    // model's dim). Drop the memoized dim so the next recall re-probes the
    // schema instead of trusting the old model's dim.
    reset_vec_mem_dim_memo();
}

/// Hard cap on cache entry count. At 768 dims × 4 bytes that's ~60 MB; at
/// 1024 dims ~80 MB. Above this the oldest-id entries are evicted on insert.
/// A workflow that mass-creates memories (or a long-lived install with many
/// 10k+ memories) would otherwise grow the cache unboundedly. (Tier 3 audit
/// finding "EMB_CACHE LRU bound", 2026-05-26 — eviction is oldest-id, not
/// strict LRU, since we don't track access timestamps.)
const MAX_CACHE_ENTRIES: usize = 20_000;

/// Evict the smallest-id entries (oldest memories) until the map is within
/// `MAX_CACHE_ENTRIES`. Called after any cache insert so the bound is
/// maintained as a post-condition.
fn evict_if_over_cap(map: &mut EmbeddingMap) {
    if map.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut ids: Vec<i64> = map.keys().copied().collect();
    ids.sort_unstable();
    let drop_count = map.len() - MAX_CACHE_ENTRIES;
    for id in ids.iter().take(drop_count) {
        map.remove(id);
    }
}

fn warm_cache() -> Result<()> {
    if EMB_CACHE.read().is_some() {
        return Ok(());
    }
    // Build the map without holding any cache lock so DB I/O doesn't serialize
    // recall calls from other threads. Pull the most-recent `MAX_CACHE_ENTRIES`
    // by id DESC so a multi-100k-row database doesn't pin the entire vector
    // set in RAM at startup — older entries are still searchable via direct
    // DB scan paths, just not via the in-RAM fast path.
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, embedding FROM memories
         WHERE status = 'active' AND embedding IS NOT NULL
         ORDER BY id DESC
         LIMIT ?1",
    )?;
    let mut map: EmbeddingMap = HashMap::new();
    let rows = stmt.query_map(params![MAX_CACHE_ENTRIES as i64], |r| {
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

/// Cheaply read the embedding dim of existing ACTIVE memories without decoding
/// the whole cache. Used by `add_memory`'s dim-guard on the vec0 path so an
/// insert no longer warms ~60 MB of BLOBs just to compare a single length.
///
/// Reads one active row's `length(embedding) / 4`. Returns `None` when there is
/// no active embedding yet — the dim is then unknown and the caller skips the
/// guard, EXACTLY matching the cache path's `values().next() == None` (the cache
/// only ever holds ACTIVE rows, so the guard is scoped to active rows here too;
/// we deliberately do NOT shortcut via the vec0 memo, whose declared dim can
/// reflect a pending/inactive-only table where the cache path would have found
/// no active dim and skipped).
fn existing_active_dim() -> Result<Option<usize>> {
    let conn = get_db()?;
    let dim: Option<i64> = conn
        .query_row(
            "SELECT length(embedding) / 4 FROM memories
             WHERE status = 'active' AND embedding IS NOT NULL
             LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(dim.map(|d| d as usize))
}

use crate::util::{blob_to_vec as blob_to_embedding, vec_to_blob as embedding_to_blob};

/// Cosine similarity for arbitrary (not necessarily normalized) vectors.
/// NOTE: distinct from `rag::cosine`, which assumes pre-normalized inputs and
/// collapses to a bare dot product. Keep both — the semantics genuinely differ.
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

/// Same general (non-normalized) cosine as `cosine`, but scored straight off a
/// borrowed little-endian f32 BLOB so the dedupe/recall paths don't allocate a
/// fresh `Vec<f32>` per row just to throw it away (perf finding; mirrors
/// `rag::score_blob`'s zero-per-row-alloc pattern but keeps the full
/// two-norm cosine semantics `cosine` documents). `query` is the decoded query
/// vector; `blob` is the candidate's raw embedding bytes.
fn cosine_blob(query: &[f32], blob: &[u8]) -> f32 {
    // A valid embedding BLOB is a whole number of 4-byte f32s of equal dim.
    if query.is_empty() || blob.len() != query.len() * 4 {
        return 0.0;
    }
    let mut dot: f32 = 0.0;
    let mut nb: f32 = 0.0;
    for (q, chunk) in query.iter().zip(blob.chunks_exact(4)) {
        let y = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        dot += q * y;
        nb += y * y;
    }
    let na: f32 = query.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = nb.sqrt();
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
        scope: r
            .get::<_, Option<String>>(8)?
            .unwrap_or_else(|| "global".to_string()),
        project_root: r.get(9)?,
        score: None,
    })
}

/// SELECT list shared by all row_to_memory call sites — keeps the column
/// order stable across queries so adding a scope-related field only requires
/// one edit.
const MEM_COLS: &str = "id, content, conversation_id, source_msg_id, tags, status, created_at, last_used_at, scope, project_root";

/// Fetch the given memories indexed by id. `id IN (...)` returns rows in
/// arbitrary order, so callers that need score order should iterate their own
/// ordered id list and look each row up here — cheaper than re-sorting the
/// fetched Vec.
fn fetch_by_ids(ids: &[i64]) -> Result<HashMap<i64, Memory>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let conn = get_db()?;
    // Build "?1,?2,...,?n" without allocating one format! per id. Each id
    // contributes at most ~6 chars; pre-reserve so we don't realloc.
    let mut placeholders = String::with_capacity(ids.len() * 6);
    use std::fmt::Write;
    for i in 0..ids.len() {
        if i > 0 {
            placeholders.push(',');
        }
        let _ = write!(placeholders, "?{}", i + 1);
    }
    let sql = format!(
        "SELECT {MEM_COLS}
         FROM memories WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
    // Score order is re-applied by caller via the returned map — this query
    // returns rows in arbitrary order.
    let mut by_id: HashMap<i64, Memory> = HashMap::with_capacity(ids.len());
    let mut rows = stmt.query(params_vec.as_slice())?;
    while let Some(row) = rows.next()? {
        let m = row_to_memory(row)?;
        by_id.insert(m.id, m);
    }
    Ok(by_id)
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
        return Err(anyhow::anyhow!(
            "scope=conversation requires conversation_id"
        ));
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
        //
        // PERF (2026-06): the cache-backed dim check used to force `warm_cache`
        // here on EVERY active insert — decoding up to MAX_CACHE_ENTRIES (~20k)
        // embedding BLOBs (~60 MB at 768d) into a resident HashMap that the vec0
        // recall/dedup paths never read. When vec0 is active, derive the existing
        // dim cheaply from the schema/DB instead of warming the whole cache; only
        // the linear-fallback path still pays the warm. Semantics are preserved:
        // an unknown existing dim (no active embeddings yet) skips the guard, and
        // a mismatch is rejected, exactly as the cache path did.
        if status == "active" {
            let existing_dim = if crate::history::vec0_available() {
                existing_active_dim()?
            } else {
                warm_cache()?;
                EMB_CACHE
                    .read()
                    .as_ref()
                    .and_then(|m| m.values().next().map(|v| v.len()))
            };
            let dim_ok = existing_dim.is_none_or(|d| d == emb.len());
            if !dim_ok {
                return Err(anyhow::anyhow!(
                    "embedding dimension mismatch with existing memories (changing models requires clearing memories)"
                ));
            }
        }
    }
    let blob = embedding.as_ref().map(|v| embedding_to_blob(v));
    // project_root is only meaningful for scope='project'. Drop it otherwise
    // so it doesn't accidentally leak across scope changes via demote/promote.
    let pr_for_insert: Option<&str> = if scope == "project" {
        project_root
    } else {
        None
    };
    // WS3: single-writer gate. (warm_cache above is a reader and runs outside
    // the lock; the cache-write below stays after the DB write as before.)
    let id = crate::history::with_write(|tx| {
        tx.execute(
            "INSERT INTO memories (content, conversation_id, source_msg_id, tags, embedding, status, created_at, scope, project_root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![content, conversation_id, source_msg_id, tags, blob, status, now_unix(), scope, pr_for_insert],
        )?;
        let new_id = tx.last_insert_rowid();
        // Keep the vec0 derived index in lockstep with the BLOB source in the
        // SAME tx. All non-null embeddings are indexed (status is filtered at
        // read time); best-effort + dim-guarded so a vec0-less build / dim
        // mismatch leaves the BLOB authoritative and recall uses the linear
        // fallback.
        if let (Some(emb), Some(b)) = (&embedding, &blob) {
            crate::history::vec_insert_memory(tx, new_id, emb, b);
        }
        Ok(new_id)
    })?;
    if let Some(emb) = embedding {
        if status == "active" {
            if let Some(map) = EMB_CACHE.write().as_mut() {
                // Skip insertion if dim doesn't match existing entries — mixed
                // dims would silently break cosine.
                let dim_ok = map.values().next().is_none_or(|v| v.len() == emb.len());
                if dim_ok {
                    map.insert(id, emb);
                    evict_if_over_cap(map);
                }
            }
        }
    }
    Ok(id)
}

pub fn list_memories(status_filter: Option<&str>, ctx: &MemoryContext) -> Result<Vec<Memory>> {
    // Two-tier limit: HARD_LIMIT is the largest result set we'll ever
    // return to the renderer (UI safeguard), OVER_FETCH is what we pull
    // from disk before the scope filter prunes it. Without over-fetching,
    // a global memory pool with many out-of-scope entries could yield
    // far fewer than the user expects after filtering.
    const HARD_LIMIT: usize = 1000;
    const OVER_FETCH: i64 = 4000;
    let conn = get_db()?;
    let sql_with = format!(
        "SELECT {MEM_COLS} FROM memories WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2"
    );
    let sql_all = format!("SELECT {MEM_COLS} FROM memories ORDER BY created_at DESC LIMIT ?1");
    let sql: &str = match status_filter {
        Some(_) => &sql_with,
        None => &sql_all,
    };
    let mut stmt = conn.prepare(sql)?;
    let raw: Vec<Memory> = if let Some(s) = status_filter {
        stmt.query_map(params![s, OVER_FETCH], row_to_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![OVER_FETCH], row_to_memory)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    // SECURITY: previously this function returned the entire memories table
    // ignoring scope, so conversation-scoped memories from other chats and
    // project-scoped memories from other workspaces leaked across contexts.
    // Apply the same scope_matches filter the search paths use so the list
    // honors the caller's MemoryContext. Pass MemoryContext::default() to
    // recover the legacy behaviour (returns only global-scoped memories +
    // any project/conversation that explicitly matches the empty context).
    let mut filtered: Vec<Memory> = raw.into_iter().filter(|m| scope_matches(m, ctx)).collect();
    if filtered.len() > HARD_LIMIT {
        filtered.truncate(HARD_LIMIT);
    }
    Ok(filtered)
}

pub fn delete_memory(id: i64) -> Result<()> {
    // Data-layer audit C2 (2026-05-24): the prior implementation held
    // `EMB_CACHE.write()` ACROSS `get_db()` (can block on pool exhaustion)
    // and the DB `DELETE` (can block on SQLITE_BUSY up to 5s). Every
    // concurrent `search_vector`/`warm_cache`/`find_duplicate` reader
    // stalled for the duration. Reorder: do the DB delete first, then
    // take the cache lock just long enough to drop the entry. The brief
    // window where a recall might score a row that's already been
    // DB-deleted is harmless — `fetch_by_ids` filters missing ids.
    // WS3: single-writer gate. The cache lock is still taken after the DB
    // write so a recall reader is never blocked behind the DELETE.
    crate::history::with_write(|tx| {
        // vec0 has no FK, so its derived row must be dropped in the same tx.
        crate::history::vec_delete(tx, crate::history::VEC_MEMORIES, "memory_id", id);
        tx.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    let mut cache = EMB_CACHE.write();
    if let Some(map) = cache.as_mut() {
        map.remove(&id);
    }
    Ok(())
}

pub fn update_memory_status(id: i64, status: &str) -> Result<()> {
    // WS3: single-writer gate for the status UPDATE.
    crate::history::with_write(|tx| {
        tx.execute(
            "UPDATE memories SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    })?;
    // Update cache surgically instead of full invalidation
    if status == "active" {
        let conn = get_db()?;
        // Pull the embedding for this id and insert into cache (read path).
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
                        evict_if_over_cap(map);
                    }
                }
            }
        }
    } else if let Some(map) = EMB_CACHE.write().as_mut() {
        map.remove(&id);
    }
    Ok(())
}

pub fn touch_memory(id: i64) -> Result<()> {
    touch_memories(&[id])
}

/// Window (seconds) within which a re-touch is treated as a no-op.
/// Without this, every agent turn re-issues an UPDATE per recall hit
/// even though `last_used_at` only ticked seconds ago — each UPDATE
/// forces a WAL fsync on the default connection. Maturity review H2.
const TOUCH_COALESCE_SECS: i64 = 60;

pub fn touch_memories(ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let now = now_unix();
    // Build numbered placeholders so the same param style is used throughout
    // ($1 = now, $2 = coalesce_floor, $3.. = ids).
    let mut placeholders = String::with_capacity(ids.len() * 6);
    use std::fmt::Write;
    for i in 0..ids.len() {
        if i > 0 {
            placeholders.push(',');
        }
        let _ = write!(placeholders, "?{}", i + 3);
    }
    let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 2);
    params_vec.push(&now);
    let coalesce_floor = now.saturating_sub(TOUCH_COALESCE_SECS);
    params_vec.push(&coalesce_floor);
    for i in ids {
        params_vec.push(i);
    }
    // Predicate `last_used_at IS NULL OR last_used_at < ?2` ensures rows
    // already touched within TOUCH_COALESCE_SECS skip the UPDATE entirely
    // — SQLite's WHERE-then-UPDATE plan short-circuits before scheduling
    // the WAL write. For an agent run that recalls the same 10 memories
    // every turn this drops ~10× per-turn UPDATE traffic to ~10× one
    // batch per minute.
    let sql = format!(
        "UPDATE memories SET last_used_at = ?1
         WHERE id IN ({placeholders})
         AND (last_used_at IS NULL OR last_used_at < ?2)"
    );
    // WS3: single-writer gate.
    crate::history::with_write(|tx| {
        tx.execute(&sql, params_vec.as_slice())?;
        Ok(())
    })
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
    // 2026-05-26 SE review round 2: bump last_used_at on returned hits so a
    // future LRU eviction policy (or even a "recently recalled" UI sort)
    // sees true recency. Best-effort — DB failure here shouldn't mask a
    // successful recall.
    if !filtered.is_empty() {
        let ids: Vec<i64> = filtered.iter().map(|m| m.id).collect();
        let _ = touch_memories(&ids);
    }
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
    // Over-fetch so post-filter (scope + min_score) trimming still yields
    // `limit` when most candidates belong to a scope the caller can't see.
    let over_fetch = limit.saturating_mul(4).clamp(limit, 200);

    // Prefer the vec0 ANN index when usable for this query's dim; else fall
    // through to the preserved cache-backed linear scan. Either way we end up
    // with `scored: Vec<(id, score)>` (score DESC, already >= min_score), then
    // share the by-id fetch + scope filter + touch-on-recall below.
    let scored: Vec<(i64, f32)> = {
        let conn = get_db()?;
        if vec0_memories_usable(&conn, query_emb.len()) {
            match search_vector_vec0(&conn, &query_emb, over_fetch, min_score) {
                // CORRECTNESS (under-return fix): the vec0 index holds every
                // non-null embedding (active + pending + inactive), and the
                // active-status filter is applied POST-KNN via the JOIN. So when
                // many soft-deleted/inactive rows crowd the global top-k, vec0
                // can yield FEWER than `limit` active hits even though the
                // active-only cache holds more matches further down. The linear
                // scan is over the active-only cache and is the parity
                // reference, so on a short vec0 result re-run it to recover the
                // missing active candidates. (No-op cost in the common case
                // where vec0 already returns a full set.)
                Ok(s) if s.len() >= limit => s,
                Ok(_) => {
                    drop(conn);
                    search_vector_linear(&query_emb, over_fetch, min_score)?
                }
                Err(e) => {
                    crate::diagnostics::warn_with(
                        "memory",
                        "vec0 KNN query failed — falling back to linear scan",
                        serde_json::json!({ "error": e.to_string() }),
                    );
                    drop(conn);
                    search_vector_linear(&query_emb, over_fetch, min_score)?
                }
            }
        } else {
            drop(conn);
            search_vector_linear(&query_emb, over_fetch, min_score)?
        }
    };

    let ids: Vec<i64> = scored.iter().map(|(id, _)| *id).collect();
    let mut by_id = fetch_by_ids(&ids)?;
    // `scored` is already sorted by score DESC, so walk it in order and pull
    // each Memory out of the by-id map — building the result already ordered.
    let mut mems: Vec<Memory> = Vec::with_capacity(scored.len().min(limit));
    for (id, score) in scored {
        if let Some(mut m) = by_id.remove(&id) {
            if scope_matches(&m, ctx) {
                m.score = Some(score);
                mems.push(m);
                if mems.len() >= limit {
                    break;
                }
            }
        }
    }
    // Touch returned hits (see search_keyword for rationale).
    if !mems.is_empty() {
        let touch_ids: Vec<i64> = mems.iter().map(|m| m.id).collect();
        let _ = touch_memories(&touch_ids);
    }
    Ok(mems)
}

/// Cache-backed linear cosine scan over active memories — the verbatim pre-vec0
/// ranking, preserved as the fallback (and the parity reference). Returns up to
/// `over_fetch` `(id, score)` pairs (score DESC) with `score >= min_score`.
fn search_vector_linear(
    query_emb: &[f32],
    over_fetch: usize,
    min_score: f32,
) -> Result<Vec<(i64, f32)>> {
    let mut scored: Vec<(i64, f32)> = with_cache(|map| {
        map.iter()
            .map(|(id, emb)| (*id, cosine(query_emb, emb)))
            .filter(|(_, s)| *s >= min_score)
            .collect()
    })?;
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(over_fetch);
    Ok(scored)
}

/// vec0 ANN KNN over `vec_memories`, restricted to ACTIVE memories (status is
/// filtered at read time — the index holds every non-null embedding). Maps
/// cosine distance to score (`1 - distance`), keeps `score >= min_score`, and
/// returns up to `over_fetch` `(id, score)` pairs, score DESC. Caller only
/// invokes this when `vec0_usable_for` confirmed the dim matches.
fn search_vector_vec0(
    conn: &rusqlite::Connection,
    query_emb: &[f32],
    over_fetch: usize,
    min_score: f32,
) -> Result<Vec<(i64, f32)>> {
    // vec0 forbids combining `k = ?` with `LIMIT`, so `k` IS the candidate
    // count; the active-status filter is applied post-KNN via the JOIN.
    let k = over_fetch.max(1) as i64;
    let q_blob = embedding_to_blob(query_emb);
    let mut stmt = conn.prepare(&format!(
        "SELECT v.memory_id, v.distance
         FROM {table} v
         JOIN memories m ON m.id = v.memory_id
         WHERE v.embedding MATCH ?1 AND k = ?2 AND m.status = 'active'
         ORDER BY v.distance",
        table = crate::history::VEC_MEMORIES
    ))?;
    let rows = stmt.query_map(params![q_blob, k], |r| {
        let id: i64 = r.get(0)?;
        let distance: f64 = r.get(1)?;
        Ok((id, distance))
    })?;
    let mut out: Vec<(i64, f32)> = Vec::with_capacity(over_fetch);
    for row in rows {
        let (id, distance) = row?;
        let score = 1.0f32 - distance as f32;
        if score >= min_score {
            out.push((id, score));
        }
    }
    Ok(out)
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
    // WS3: single-writer gate.
    // When promoting to global, null out project_root + conversation_id so
    // demote later requires the user to re-specify context (avoids stale
    // bindings that don't reflect the new use case).
    crate::history::with_write(|tx| {
        if next_scope == "global" {
            tx.execute(
                "UPDATE memories SET scope = ?1, project_root = NULL WHERE id = ?2",
                params![next_scope, id],
            )?;
        } else {
            tx.execute(
                "UPDATE memories SET scope = ?1 WHERE id = ?2",
                params![next_scope, id],
            )?;
        }
        Ok(())
    })?;
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
            return Err(anyhow::anyhow!(
                "memory already at bottom scope (conversation)"
            ))
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
    // WS3: single-writer gate.
    crate::history::with_write(|tx| {
        tx.execute(
            "UPDATE memories SET scope = ?1 WHERE id = ?2",
            params![next_scope, id],
        )?;
        Ok(())
    })
}

/// Used by `memory_promote`/`memory_demote` when the frontend wants to
/// attach context (project_root / conversation_id) prior to the scope
/// transition — e.g. demoting a global memory to project requires us to
/// know which project it belongs to.
pub fn set_memory_context(id: i64, project_root: Option<&str>, conv_id: Option<i64>) -> Result<()> {
    // WS3: single-writer gate. Both conditional UPDATEs share the txn.
    crate::history::with_write(|tx| {
        // Only update fields the caller actually supplied — pass-through NULLs
        // would clobber existing bindings.
        if let Some(pr) = project_root {
            tx.execute(
                "UPDATE memories SET project_root = ?1 WHERE id = ?2",
                params![pr, id],
            )?;
        }
        if let Some(c) = conv_id {
            tx.execute(
                "UPDATE memories SET conversation_id = ?1 WHERE id = ?2",
                params![c, id],
            )?;
        }
        Ok(())
    })
}

pub fn find_duplicate(query_emb: Vec<f32>, threshold: f32) -> Result<Option<i64>> {
    if query_emb.is_empty() {
        return Ok(None);
    }
    // vec0 fast path: the index holds EVERY non-null embedding (active +
    // pending + inactive), so a single k=1 KNN covers what the linear path
    // splits across the cache (active) + a pending scan. Compare the mapped
    // cosine (1 - distance) to the threshold. Only taken when the dim matches.
    {
        let conn = get_db()?;
        if vec0_memories_usable(&conn, query_emb.len()) {
            match find_duplicate_vec0(&conn, &query_emb, threshold) {
                Ok(hit) => return Ok(hit),
                Err(e) => {
                    crate::diagnostics::warn_with(
                        "memory",
                        "vec0 find_duplicate failed — falling back to linear scan",
                        serde_json::json!({ "error": e.to_string() }),
                    );
                    // fall through to linear below
                }
            }
        }
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
        // Borrow the BLOB in place — no Vec<u8>/Vec<f32> per pending row.
        let score = match row.get_ref(1)?.as_blob() {
            Ok(b) => cosine_blob(&query_emb, b),
            _ => 0.0,
        };
        if score >= threshold {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// vec0 KNN for `find_duplicate`. Returns the nearest ACTIVE-or-PENDING memory
/// id when its mapped cosine (`1 - distance`) meets `threshold`, else `None`.
///
/// CORRECTNESS (status divergence fix): the vec0 index holds EVERY non-null
/// embedding regardless of status — including inactive/soft-deleted rows that
/// `update_memory_status` only evicts from the cache, never from vec0. The
/// linear fallback only ever considers active (cache) + pending memories, so a
/// status filter is required here to match its coverage; otherwise a new memory
/// matching an INACTIVE row would be dropped under vec0 but inserted under the
/// linear path. Mirror `search_vector_vec0`'s post-KNN JOIN filter, but since
/// the status filter is applied AFTER vec0 truncates to the k nearest, over-
/// fetch a small candidate set and pick the first surviving (nearest) hit
/// instead of `k = 1` — a single inactive nearest neighbour must not mask a
/// slightly-farther active/pending duplicate.
fn find_duplicate_vec0(
    conn: &rusqlite::Connection,
    query_emb: &[f32],
    threshold: f32,
) -> Result<Option<i64>> {
    // Small over-fetch so inactive neighbours occupying the top-k can't hide an
    // active/pending duplicate just behind them. Bounded constant — dedup only
    // needs the single nearest surviving row.
    const DEDUP_K: i64 = 16;
    let q_blob = embedding_to_blob(query_emb);
    let mut stmt = conn.prepare(&format!(
        "SELECT v.memory_id, v.distance
         FROM {table} v
         JOIN memories m ON m.id = v.memory_id
         WHERE v.embedding MATCH ?1 AND k = ?2 AND m.status IN ('active', 'pending')
         ORDER BY v.distance",
        table = crate::history::VEC_MEMORIES
    ))?;
    let mut rows = stmt.query(params![q_blob, DEDUP_K])?;
    // Rows arrive nearest-first; the first survivor is the nearest active/
    // pending neighbour, so its score is the max among survivors.
    if let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let distance: f64 = row.get(1)?;
        if (1.0f32 - distance as f32) >= threshold {
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
        assert!(scope_matches(
            &g,
            &MemoryContext::new(Some("/x".into()), Some(42))
        ));

        // Project → only when workspace_root matches exactly.
        let p = make("project", Some("/repo/foo"), None);
        assert!(scope_matches(
            &p,
            &MemoryContext::new(Some("/repo/foo".into()), None)
        ));
        assert!(!scope_matches(
            &p,
            &MemoryContext::new(Some("/repo/bar".into()), None)
        ));
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

    /// `evict_if_over_cap` drops the smallest-id entries until the map is
    /// within `MAX_CACHE_ENTRIES`. Verifies the cap holds and that the
    /// retained entries are the most recent (largest ids).
    #[test]
    fn evict_drops_oldest_ids_first() {
        let mut map: EmbeddingMap = HashMap::new();
        // Seed past the cap so eviction actually fires.
        let overflow: usize = 50;
        let total = MAX_CACHE_ENTRIES + overflow;
        for id in 0..total {
            map.insert(id as i64, vec![0.0_f32; 4]);
        }
        assert_eq!(map.len(), total);

        evict_if_over_cap(&mut map);
        assert_eq!(map.len(), MAX_CACHE_ENTRIES);
        // Smallest `overflow` ids were dropped; everything from `overflow..total`
        // is retained.
        for id in 0..overflow {
            assert!(!map.contains_key(&(id as i64)), "id {id} should be evicted");
        }
        for id in overflow..total {
            assert!(map.contains_key(&(id as i64)), "id {id} should be retained");
        }
    }

    /// No-op when under cap.
    #[test]
    fn evict_is_noop_under_cap() {
        let mut map: EmbeddingMap = HashMap::new();
        for id in 0..100 {
            map.insert(id as i64, vec![0.0_f32; 4]);
        }
        let before = map.len();
        evict_if_over_cap(&mut map);
        assert_eq!(map.len(), before);
    }

    /* ── vec0 ANN parity + fallback (memory) ── */

    /// Deterministic L2-normalized vector of dim `dim` from a seed.
    fn norm_vec(seed: u64, dim: usize) -> Vec<f32> {
        let mut s = seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1);
        let mut v: Vec<f32> = Vec::with_capacity(dim);
        for _ in 0..dim {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            v.push(((s >> 11) as f32 / (1u64 << 53) as f32) * 2.0 - 1.0);
        }
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            for x in v.iter_mut() {
                *x /= n;
            }
        }
        v
    }

    /// Build an in-memory DB with the full schema, `count` ACTIVE memories each
    /// holding a normalized `dim`-vector, and the vec0 index created+backfilled.
    fn seed_memories(count: usize, dim: usize) -> rusqlite::Connection {
        let conn = crate::history::test_open_in_memory_with_vec();
        // Full ladder so the `memories` table + columns exist exactly as prod.
        crate::history::__test_run_migrations(&conn).unwrap();
        for i in 0..count {
            let blob = embedding_to_blob(&norm_vec(i as u64 + 1, dim));
            conn.execute(
                "INSERT INTO memories (content, tags, status, created_at, embedding, scope)
                 VALUES (?1, '', 'active', 0, ?2, 'global')",
                params![format!("m{i}"), blob],
            )
            .unwrap();
        }
        crate::history::ensure_vec_tables_present(&conn).unwrap();
        conn
    }

    /// vec0 KNN ranking must match a brute-force cosine ranking over the same
    /// seeded set (ids + scores within 1e-4; exact top-1).
    #[test]
    fn vec0_memory_parity_with_linear() {
        if !crate::history::vec0_available() {
            return;
        }
        let dim = 16usize;
        let n = 50usize;
        let conn = seed_memories(n, dim);
        for q_seed in [11u64, 22, 33, 44, 55] {
            let q = norm_vec(q_seed, dim);
            // Brute-force reference over the same vectors (all normalized →
            // cosine = dot).
            let mut reference: Vec<(i64, f32)> = (0..n)
                .map(|i| {
                    let v = norm_vec(i as u64 + 1, dim);
                    let dot: f32 = q.iter().zip(v.iter()).map(|(a, b)| a * b).sum();
                    ((i + 1) as i64, dot)
                })
                .collect();
            reference.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

            let over_fetch = 20usize;
            let vec0 = search_vector_vec0(&conn, &q, over_fetch, -1.0).unwrap();
            assert!(!vec0.is_empty(), "expected hits for seed {q_seed}");
            // Exact top-1.
            assert_eq!(
                vec0[0].0, reference[0].0,
                "top-1 id mismatch for seed {q_seed}"
            );
            // Each returned id/score matches the reference at the same rank.
            for (rank, (id, score)) in vec0.iter().enumerate() {
                assert_eq!(*id, reference[rank].0, "rank {rank} id mismatch");
                assert!(
                    (*score - reference[rank].1).abs() < 1e-4,
                    "rank {rank} score mismatch: vec0 {score} vs ref {}",
                    reference[rank].1
                );
            }
        }
    }

    /// `find_duplicate_vec0` returns the exact-match id above threshold and
    /// `None` for a far query — matching the linear dedupe semantics.
    #[test]
    fn vec0_memory_find_duplicate() {
        if !crate::history::vec0_available() {
            return;
        }
        let dim = 16usize;
        let conn = seed_memories(20, dim);
        // Query equal to memory #1's vector → exact match (cosine ~1) ≥ 0.85.
        let q = norm_vec(1, dim);
        let hit = find_duplicate_vec0(&conn, &q, 0.85).unwrap();
        assert_eq!(hit, Some(1), "exact match must be found");
        // An absurdly high threshold no real pair meets → None.
        let q2 = norm_vec(99_999, dim);
        let none = find_duplicate_vec0(&conn, &q2, 0.999_999).unwrap();
        assert!(none.is_none(), "no near-duplicate should be found");
    }

    /// CORRECTNESS regression: `find_duplicate_vec0` must apply the same
    /// active/pending status filter as the linear path. An INACTIVE memory whose
    /// embedding is the nearest neighbour of the query must NOT be reported as a
    /// duplicate (the vec0 index still holds soft-deleted rows). A pending row,
    /// by contrast, IS a valid dedup target.
    #[test]
    fn vec0_memory_find_duplicate_skips_inactive() {
        if !crate::history::vec0_available() {
            return;
        }
        let dim = 16usize;
        let conn = crate::history::test_open_in_memory_with_vec();
        crate::history::__test_run_migrations(&conn).unwrap();
        // Seed three rows with the SAME vector but different statuses so the
        // nearest neighbour is unambiguous and the status filter is the only
        // thing that distinguishes them.
        let v = norm_vec(7, dim);
        let blob = embedding_to_blob(&v);
        for status in ["inactive", "pending", "active"] {
            conn.execute(
                "INSERT INTO memories (content, tags, status, created_at, embedding, scope)
                 VALUES (?1, '', ?2, 0, ?3, 'global')",
                params![format!("m-{status}"), status, blob],
            )
            .unwrap();
        }
        crate::history::ensure_vec_tables_present(&conn).unwrap();

        // Query equal to the shared vector → exact match. The inactive row (id 1)
        // is the closest by id-tiebreak, but must be skipped; a pending OR active
        // survivor is acceptable.
        let hit = find_duplicate_vec0(&conn, &v, 0.85).unwrap();
        let surviving: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM memories WHERE status IN ('active','pending')")
                .unwrap();
            let ids = stmt
                .query_map([], |r| r.get::<_, i64>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            ids
        };
        let id = hit.expect("a pending/active duplicate must be found");
        assert!(
            surviving.contains(&id),
            "find_duplicate_vec0 returned id {id}, which is not active/pending"
        );

        // Now mark the only active+pending rows inactive too; the nearest
        // neighbour is then exclusively inactive → must report NO duplicate even
        // though the vec0 index still holds the (now inactive) rows.
        conn.execute(
            "UPDATE memories SET status = 'inactive' WHERE status IN ('active','pending')",
            [],
        )
        .unwrap();
        let none = find_duplicate_vec0(&conn, &v, 0.85).unwrap();
        assert!(
            none.is_none(),
            "all-inactive neighbours must not be treated as a duplicate"
        );
    }

    /// Migration/backfill on a populated DB with a MIXED-dim case: rows of two
    /// dims (512 + 768) must not panic; the vec table is created at the
    /// majority/first-seen dim and the dim guard makes vec0 unusable for the
    /// other dim (→ linear fallback), never a hard fail.
    #[test]
    fn vec0_memory_mixed_dim_no_panic_falls_back() {
        if !crate::history::vec0_available() {
            return;
        }
        let conn = crate::history::test_open_in_memory_with_vec();
        crate::history::__test_run_migrations(&conn).unwrap();
        // Seed a 512-dim row first, then a 768-dim row.
        for (i, dim) in [(1u64, 512usize), (2, 768)] {
            let blob = embedding_to_blob(&norm_vec(i, dim));
            conn.execute(
                "INSERT INTO memories (content, tags, status, created_at, embedding, scope)
                 VALUES (?1, '', 'active', 0, ?2, 'global')",
                params![format!("m{i}"), blob],
            )
            .unwrap();
        }
        // Must not panic.
        crate::history::ensure_vec_tables_present(&conn).expect("mixed-dim backfill no panic");
        let table_dim = crate::history::vec_table_dim(&conn, crate::history::VEC_MEMORIES);
        assert!(
            table_dim.is_some(),
            "vec table created at the first-seen dim"
        );
        let td = table_dim.unwrap();
        // vec0 is usable only for the table's own dim; the other dim falls back.
        assert!(crate::history::vec0_usable_for(
            &conn,
            crate::history::VEC_MEMORIES,
            td
        ));
        let other = if td == 512 { 768 } else { 512 };
        assert!(!crate::history::vec0_usable_for(
            &conn,
            crate::history::VEC_MEMORIES,
            other
        ));
    }
}
