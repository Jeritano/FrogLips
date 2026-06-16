use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use r2d2::{ManageConnection, Pool, PooledConnection};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/* ── sqlite-vec (vec0) auto-extension registration ── */

/// Set once `SELECT vec_version()` succeeds on the schema connection. When
/// false (registration failed, old SQLite, etc.) every vector query falls
/// through to the preserved linear-scan path — the BLOB columns are the source
/// of truth, so nothing is lost. Read by `rag` + `memory` via
/// `vec0_available()`.
pub(crate) static VEC0_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Register the sqlite-vec `vec0` virtual table as an SQLite auto-extension
/// exactly once, process-wide, BEFORE any `Connection` is opened. Auto-
/// extensions run their init on every subsequent connection (pool slots,
/// in-memory test conns), so vec0 is available everywhere without a per-conn
/// load call. Uses `rusqlite::ffi` which is exposed by the `bundled` feature —
/// no `loadable_extension` feature, so no dylib ships (notarization unaffected).
pub(crate) fn register_vec0_once() {
    static REGISTER: std::sync::Once = std::sync::Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `sqlite3_vec_init` is the canonical sqlite-vec entrypoint with
        // the SQLite extension-init ABI. We transmute its fn pointer to the
        // `sqlite3_auto_extension` callback type (the SQLite extension-init
        // `unsafe extern "C" fn(...) -> c_int`), exactly as the sqlite-vec
        // README prescribes. Called once before any connection opens, so there
        // is no concurrent FFI registration. The explicit annotation satisfies
        // clippy::missing_transmute_annotations.
        type SqliteEntrypoint = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::os::raw::c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> std::os::raw::c_int;
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                SqliteEntrypoint,
            >(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// Whether vec0 KNN is usable this process (set after the boot probe).
pub(crate) fn vec0_available() -> bool {
    VEC0_AVAILABLE.load(Ordering::Relaxed)
}

/* ── vec0 derived-index helpers (shared by rag + memory) ── */

/// Name of the vec0 table mirroring `rag_chunks` embeddings (keyed on chunk id).
pub(crate) const VEC_RAG_CHUNKS: &str = "vec_rag_chunks";
/// Name of the vec0 table mirroring `memories` embeddings (keyed on memory id).
pub(crate) const VEC_MEMORIES: &str = "vec_memories";

/// Whether a regular/virtual table named `name` exists.
pub(crate) fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(n == 1)
}

/// Inspect a vec0 table's declared embedding dimension by parsing its
/// `CREATE VIRTUAL TABLE … vec0(… float[DIM] …)` SQL out of `sqlite_master`.
/// Returns `None` when the table is absent or the dim can't be parsed.
pub(crate) fn vec_table_dim(conn: &Connection, name: &str) -> Option<usize> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?1",
            params![name],
            |r| r.get(0),
        )
        .ok()?;
    // Find `float[<n>]` and parse <n>.
    let lower = sql.to_ascii_lowercase();
    let idx = lower.find("float[")?;
    let rest = &sql[idx + "float[".len()..];
    let end = rest.find(']')?;
    rest[..end].trim().parse::<usize>().ok()
}

/// Create the vec0 virtual table `name` at dimension `dim` if missing. The
/// primary key is the source table's row id; cosine distance is declared so a
/// score is `1 - distance` over the L2-normalized vectors we store. No-op when
/// vec0 is unavailable (caller keeps the linear fallback).
pub(crate) fn ensure_vec_table(conn: &Connection, name: &str, dim: usize) -> Result<()> {
    if !vec0_available() || dim == 0 {
        return Ok(());
    }
    let pk = match name {
        VEC_RAG_CHUNKS => "chunk_id",
        VEC_MEMORIES => "memory_id",
        _ => "rowid",
    };
    // `name`, `pk` and `dim` are all crate constants / parsed integers — never
    // user input — so the format is safe. vec0 has no IF-NOT-EXISTS column
    // semantics issue; `CREATE VIRTUAL TABLE IF NOT EXISTS` is supported.
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(
            {pk} INTEGER PRIMARY KEY,
            embedding float[{dim}] distance_metric=cosine
         );"
    ))?;
    Ok(())
}

/// Infer the embedding dimension from the source table's existing BLOBs
/// (`length(embedding)/4`). Returns the first non-null embedding's dim, or
/// `None` when the source has no usable vectors yet (table created lazily on
/// first write). `where_clause` narrows to indexable rows (e.g. non-null
/// embedding).
fn infer_dim(conn: &Connection, table: &str, where_clause: &str) -> Option<usize> {
    let sql = format!(
        "SELECT length(embedding)/4 FROM {table} WHERE {where_clause} \
         AND embedding IS NOT NULL AND length(embedding) >= 4 LIMIT 1"
    );
    conn.query_row(&sql, [], |r| r.get::<_, i64>(0))
        .ok()
        .filter(|d| *d > 0)
        .map(|d| d as usize)
}

/// Idempotently create + backfill the vec0 tables from the BLOB source tables.
/// Called once after `setup_schema` on the schema connection (and exercised by
/// the vec0 migration rungs). Best-effort + guarded: a vec0-less build returns
/// `Ok(())` without touching anything, so the app keeps working on the linear
/// fallback. The vec table is created at the source data's dim; rows whose
/// embedding length matches that dim are backfilled with `INSERT OR IGNORE`
/// (vec0 accepts the raw little-endian f32 BLOB directly).
pub(crate) fn ensure_vec_tables_present(conn: &Connection) -> Result<()> {
    if !vec0_available() {
        return Ok(());
    }
    // RAG chunks (every row has a NOT NULL embedding).
    if table_exists(conn, "rag_chunks")? {
        if let Some(dim) = infer_dim(conn, "rag_chunks", "1=1") {
            ensure_vec_table(conn, VEC_RAG_CHUNKS, dim)?;
            backfill_vec_rag(conn, dim)?;
        }
    }
    // Memories (only rows with a non-null embedding are indexable).
    if table_exists(conn, "memories")? {
        if let Some(dim) = infer_dim(conn, "memories", "embedding IS NOT NULL") {
            ensure_vec_table(conn, VEC_MEMORIES, dim)?;
            backfill_vec_memories(conn, dim)?;
        }
    }
    Ok(())
}

/// Pure-SQL backfill of `vec_rag_chunks` from `rag_chunks` for rows whose
/// embedding matches `dim`. Idempotent via a `NOT IN (already-indexed)` guard —
/// vec0 does NOT honor `INSERT OR IGNORE` on a PK conflict (it raises a UNIQUE
/// constraint error regardless), so we exclude rows already present.
pub(crate) fn backfill_vec_rag(conn: &Connection, dim: usize) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {VEC_RAG_CHUNKS}(chunk_id, embedding)
             SELECT id, embedding FROM rag_chunks
             WHERE length(embedding) = ?1
               AND id NOT IN (SELECT chunk_id FROM {VEC_RAG_CHUNKS})"
        ),
        params![(dim * 4) as i64],
    )?;
    Ok(())
}

/// Pure-SQL backfill of `vec_memories` from `memories` (any non-null embedding
/// of matching dim, regardless of status — status is filtered at read time).
/// Idempotent via the same `NOT IN (already-indexed)` guard as `backfill_vec_rag`.
pub(crate) fn backfill_vec_memories(conn: &Connection, dim: usize) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {VEC_MEMORIES}(memory_id, embedding)
             SELECT id, embedding FROM memories
             WHERE embedding IS NOT NULL AND length(embedding) = ?1
               AND id NOT IN (SELECT memory_id FROM {VEC_MEMORIES})"
        ),
        params![(dim * 4) as i64],
    )?;
    Ok(())
}

/// Per-query fallback decision: can vec0 KNN serve a query of dimension
/// `query_dim` against `table`? True only when vec0 linked this process, the
/// table exists, and its declared dim equals the query dim (a 512-corpus query
/// against a 768-dim table must NOT use vec0 — fall to linear). Any error
/// reading the schema is treated as "not usable".
///
/// Production hot paths now use the per-table memoized wrappers
/// (memory::vec0_memories_usable / rag::vec0_rag_usable, which cache the declared
/// dim via `vec_table_dim` to skip the per-call sqlite_master probes). This
/// authoritative non-memoized probe is retained as the reference oracle the
/// memory/rag tests assert against, so it has no non-test caller in the lib build.
#[allow(dead_code)]
pub(crate) fn vec0_usable_for(conn: &Connection, table: &str, query_dim: usize) -> bool {
    if !vec0_available() || query_dim == 0 {
        return false;
    }
    match table_exists(conn, table) {
        Ok(true) => vec_table_dim(conn, table) == Some(query_dim),
        _ => false,
    }
}

/// Insert one RAG chunk's embedding into `vec_rag_chunks` in the SAME tx as the
/// BLOB write. Lazily creates the table at the vector's dim on the first write,
/// and skips (logging once) if the table already exists at a different dim — the
/// BLOB stays authoritative and search uses the linear fallback for that corpus.
/// Best-effort: any vec0 error is logged, never propagated, so the chunk write
/// itself can't be lost.
pub(crate) fn vec_insert_rag_chunk(
    tx: &rusqlite::Transaction<'_>,
    chunk_id: i64,
    emb: &[f32],
    blob: &[u8],
) {
    // RAG ingest only ever inserts a freshly-allocated chunk rowid, so the
    // pre-DELETE can never match — skip it (`allow_replace = false`) to avoid an
    // always-no-op write per chunk across a large ingest.
    vec_insert(tx, VEC_RAG_CHUNKS, "chunk_id", chunk_id, emb, blob, false);
}

/// Insert one memory's embedding into `vec_memories` in the same tx as the BLOB
/// write. Same lazy-create + dim-guard + best-effort semantics as
/// `vec_insert_rag_chunk`.
pub(crate) fn vec_insert_memory(
    tx: &rusqlite::Transaction<'_>,
    memory_id: i64,
    emb: &[f32],
    blob: &[u8],
) {
    // Memory keeps `allow_replace = true` so the documented re-activation path
    // (re-inserting a memory's vec row at an existing id) can't trip a UNIQUE
    // constraint.
    vec_insert(tx, VEC_MEMORIES, "memory_id", memory_id, emb, blob, true);
}

/// `allow_replace`: when true, delete any existing vec row for `id` before the
/// INSERT (vec0 has no INSERT OR REPLACE) so a re-insert at an existing id is
/// safe. Insert-only callers (RAG ingest, which always uses a fresh rowid) pass
/// false to skip the always-no-op pre-DELETE on the hot ingest path.
fn vec_insert(
    tx: &rusqlite::Transaction<'_>,
    name: &str,
    pk: &str,
    id: i64,
    emb: &[f32],
    blob: &[u8],
    allow_replace: bool,
) {
    if !vec0_available() || emb.is_empty() {
        return;
    }
    let dim = emb.len();
    // Create lazily at this vector's dim if absent.
    match table_exists(tx, name) {
        Ok(false) => {
            if let Err(e) = ensure_vec_table(tx, name, dim) {
                crate::diagnostics::warn_with(
                    "vec0",
                    "lazy vec table create failed",
                    serde_json::json!({ "table": name, "dim": dim, "error": e.to_string() }),
                );
                return;
            }
        }
        Ok(true) => {
            // Dim mismatch → the BLOB stays the source of truth; don't poison
            // the vec index with a row vec0 would reject anyway.
            if vec_table_dim(tx, name) != Some(dim) {
                return;
            }
        }
        Err(_) => return,
    }
    // vec0 doesn't support `INSERT OR REPLACE`; on the replace path delete any
    // existing row for this id first (no-op when absent) so a re-insert (e.g.
    // re-activating a memory) can't trip a UNIQUE constraint. Insert-only
    // callers skip this — the pre-DELETE would never match a fresh rowid.
    if allow_replace {
        let _ = tx.execute(
            &format!("DELETE FROM {name} WHERE {pk} = ?1"),
            params![id],
        );
    }
    if let Err(e) = tx.execute(
        &format!("INSERT INTO {name}({pk}, embedding) VALUES (?1, ?2)"),
        params![id, blob],
    ) {
        crate::diagnostics::warn_with(
            "vec0",
            "vec row insert failed (blob source intact; linear fallback)",
            serde_json::json!({ "table": name, "id": id, "error": e.to_string() }),
        );
    }
}

/// Delete a vec0 row by primary key inside `tx`. Best-effort; vec0 has no FK so
/// the source table's cascade does not reach it. No-op if vec0 unavailable or
/// the table is absent.
pub(crate) fn vec_delete(tx: &rusqlite::Transaction<'_>, name: &str, pk: &str, id: i64) {
    if !vec0_available() {
        return;
    }
    if matches!(table_exists(tx, name), Ok(true)) {
        let _ = tx.execute(
            &format!("DELETE FROM {name} WHERE {pk} = ?1"),
            params![id],
        );
    }
}

/// Drop a vec0 table inside `tx` (used on embedder switch). Best-effort.
pub(crate) fn vec_drop_table(tx: &rusqlite::Transaction<'_>, name: &str) {
    if !vec0_available() {
        return;
    }
    let _ = tx.execute_batch(&format!("DROP TABLE IF EXISTS {name};"));
}

/// Backfill `vec_rag_chunks` rows for a corpus+path's chunks ABOVE the
/// watermark (the copy-forward path's newly-inserted rows). Best-effort +
/// dim-guarded: only chunks whose BLOB matches the vec table's dim are added
/// (vec0 would reject a mismatch). No-op if vec0 unavailable.
pub(crate) fn vec_backfill_rag_above(
    tx: &rusqlite::Transaction<'_>,
    corpus_id: i64,
    path: &str,
    watermark: i64,
) {
    if !vec0_available() || !matches!(table_exists(tx, VEC_RAG_CHUNKS), Ok(true)) {
        return;
    }
    let Some(dim) = vec_table_dim(tx, VEC_RAG_CHUNKS) else {
        return;
    };
    let _ = tx.execute(
        &format!(
            "INSERT INTO {VEC_RAG_CHUNKS}(chunk_id, embedding)
             SELECT id, embedding FROM rag_chunks
             WHERE corpus_id = ?1 AND path = ?2 AND id > ?3 AND length(embedding) = ?4
               AND id NOT IN (SELECT chunk_id FROM {VEC_RAG_CHUNKS})"
        ),
        params![corpus_id, path, watermark, (dim * 4) as i64],
    );
}

/// Delete the vec0 rows for a corpus's OLD generation (chunks at/below the
/// watermark) — mirrors the atomic-swap delete. Best-effort. Must run BEFORE
/// the rag_chunks delete so the ids still resolve via the join subquery.
pub(crate) fn vec_delete_rag_old_generation(
    tx: &rusqlite::Transaction<'_>,
    corpus_id: i64,
    watermark: i64,
) {
    if !vec0_available() || !matches!(table_exists(tx, VEC_RAG_CHUNKS), Ok(true)) {
        return;
    }
    let _ = tx.execute(
        &format!(
            "DELETE FROM {VEC_RAG_CHUNKS} WHERE chunk_id IN (
                SELECT id FROM rag_chunks WHERE corpus_id = ?1 AND id <= ?2
             )"
        ),
        params![corpus_id, watermark],
    );
}

/// Delete all vec0 rows belonging to a corpus (used by delete_corpus before the
/// FK cascade drops the rag_chunks rows). Best-effort.
pub(crate) fn vec_delete_rag_corpus(tx: &rusqlite::Transaction<'_>, corpus_id: i64) {
    if !vec0_available() || !matches!(table_exists(tx, VEC_RAG_CHUNKS), Ok(true)) {
        return;
    }
    let _ = tx.execute(
        &format!(
            "DELETE FROM {VEC_RAG_CHUNKS} WHERE chunk_id IN (
                SELECT id FROM rag_chunks WHERE corpus_id = ?1
             )"
        ),
        params![corpus_id],
    );
}

/// After an embedder switch rebuilt `vec_rag_chunks` at a new dim, re-add every
/// chunk whose BLOB matches the (new) table dim — recovers other corpora that
/// already live in the new space. Best-effort + idempotent (`INSERT OR IGNORE`).
pub(crate) fn vec_backfill_rag_all_matching_dim(tx: &rusqlite::Transaction<'_>) {
    if !vec0_available() || !matches!(table_exists(tx, VEC_RAG_CHUNKS), Ok(true)) {
        return;
    }
    if let Some(dim) = vec_table_dim(tx, VEC_RAG_CHUNKS) {
        let _ = tx.execute(
            &format!(
                "INSERT INTO {VEC_RAG_CHUNKS}(chunk_id, embedding)
                 SELECT id, embedding FROM rag_chunks
                 WHERE length(embedding) = ?1
                   AND id NOT IN (SELECT chunk_id FROM {VEC_RAG_CHUNKS})"
            ),
            params![(dim * 4) as i64],
        );
    }
}

/// Test-only: register vec0 + open a fresh in-memory connection that has the
/// extension available, and flip `VEC0_AVAILABLE` based on a live probe. Every
/// `#[cfg(test)]` that opens an in-memory `Connection` and exercises vec tables
/// must go through this so the auto-extension is registered first.
#[cfg(test)]
pub(crate) fn test_open_in_memory_with_vec() -> Connection {
    register_vec0_once();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    // Probe so VEC0_AVAILABLE reflects reality for the fallback-decision code
    // under test. Best-effort: a build without vec leaves it false.
    let ok = conn
        .query_row("SELECT vec_version()", [], |r| r.get::<_, String>(0))
        .is_ok();
    if ok {
        VEC0_AVAILABLE.store(true, Ordering::Relaxed);
    }
    conn
}

/* ── Connection pool ── */

pub(crate) struct SqliteManager {
    path: PathBuf,
}

impl ManageConnection for SqliteManager {
    type Connection = Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             -- Maturity review P0 #6 + P1 #19. cache_size negative value
             -- is KiB rather than pages (here ~16 MiB resident per conn);
             -- mmap_size 256 MiB lets large `messages`/`memories` scans
             -- read pages without the syscall ping-pong; synchronous=NORMAL
             -- is safe under WAL (FULL only differs on crash semantics
             -- around the journal checkpoint, not durability of committed
             -- txns); temp_store=MEMORY skips disk for sort/group temp.
             PRAGMA cache_size=-16000;
             PRAGMA mmap_size=268435456;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=MEMORY;",
        )?;
        // P0 #6: bump prepared-statement cache so the busy code paths
        // (list_messages, search_text, memory recall) don't reparse SQL
        // every call. Default cap is 16; bumping to 64 covers every hot
        // query without eating much RAM.
        conn.set_prepared_statement_cache_capacity(64);
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Connection) -> rusqlite::Result<()> {
        // Cheap liveness probe — fails fast if the connection is dead.
        conn.execute_batch("SELECT 1")
    }

    fn has_broken(&self, conn: &mut Connection) -> bool {
        // A connection is broken if it can no longer run a trivial query.
        conn.execute_batch("SELECT 1").is_err()
    }
}

/// Lazy-built connection pool. Wrapped in a `Result` so a failure to build the
/// pool (disk full, permission denied on `~/.local-llm-app`, corrupt DB that
/// quarantine couldn't move aside, etc.) is *captured* rather than panicking
/// the whole app at first DB touch. `get_db()` surfaces the failure as a
/// regular `Err` so the UI can show "DB unavailable" instead of crashing, and
/// `db_unavailable_notice()` exposes the message for an IPC banner.
static DB: Lazy<Result<Pool<SqliteManager>, String>> =
    Lazy::new(|| build_pool().map_err(|e| e.to_string()));

/// Set when a corrupt DB was detected and quarantined on startup. Holds the
/// path the corrupt file was renamed to so a command can surface it.
static DB_RECOVERY: RwLock<Option<String>> = RwLock::new(None);

/// If a corrupt DB was quarantined this run, returns the path of the renamed
/// corrupt file. `None` means the DB opened cleanly.
pub fn recovery_notice() -> Option<String> {
    DB_RECOVERY.read().clone()
}

/// If the DB pool failed to build (disk full, permission denied, etc.),
/// returns the underlying error string for surfacing in the UI. `None` means
/// the pool is healthy. Safe to call from any IPC command — never panics.
///
/// Intended caller: an IPC command (e.g. `db_unavailable_notice`) that the
/// frontend probes on app boot to show a "DB unavailable" banner instead of
/// every history-touching command failing with a generic error.
///
/// Code review H8: was previously `#[allow(dead_code)]` and never wired
/// as an IPC, so the frontend could only see the symptom (generic IPC
/// failures) not the cause. Now exposed via the `db_unavailable_notice`
/// command registered in `lib.rs::generate_handler!`.
pub fn db_unavailable_notice() -> Option<String> {
    match &*DB {
        Ok(_) => None,
        Err(e) => Some(e.clone()),
    }
}

pub(crate) fn db_path() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let base = home.join(".local-llm-app");
    std::fs::create_dir_all(&base).context("failed to create ~/.local-llm-app")?;
    Ok(base.join("db.sqlite"))
}

/// RFC3339-ish UTC timestamp safe for use in a filename (no colons).
fn quarantine_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Reuse the colon-free convention: YYYYMMDDTHHMMSSZ.
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}{m:02}{d:02}T{hh:02}{mm:02}{ss:02}Z")
}

/// Run `PRAGMA integrity_check` on the DB at `path`. Returns `true` when the
/// DB is healthy ("ok"), `false` when corruption is detected. A DB that cannot
/// even be opened is treated as corrupt so it gets quarantined.
fn integrity_ok(path: &Path) -> bool {
    if !path.exists() {
        // A non-existent DB is fine — schema setup will create a fresh one.
        return true;
    }
    let conn = match Connection::open(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(s) => s == "ok",
        Err(_) => false,
    }
}

/// Rename a corrupt DB (and its `-wal`/`-shm` siblings) out of the way so
/// schema setup can build a fresh DB in its place. Records the quarantine
/// location in `DB_RECOVERY`. Best-effort on the siblings — they may not exist.
fn quarantine_corrupt_db(path: &Path) -> Result<()> {
    let stamp = quarantine_stamp();
    let corrupt = {
        let mut s = path.as_os_str().to_owned();
        s.push(format!(".corrupt-{stamp}"));
        PathBuf::from(s)
    };
    std::fs::rename(path, &corrupt)
        .with_context(|| format!("failed to quarantine corrupt db to {}", corrupt.display()))?;
    for suffix in ["-wal", "-shm"] {
        let mut sib = path.as_os_str().to_owned();
        sib.push(suffix);
        let sib = PathBuf::from(sib);
        if sib.exists() {
            let mut dst = corrupt.as_os_str().to_owned();
            dst.push(suffix);
            let _ = std::fs::rename(&sib, PathBuf::from(dst));
        }
    }
    let notice = corrupt.display().to_string();
    crate::diagnostics::error_with(
        "db",
        "corrupt database detected on startup — quarantined and recreated",
        serde_json::json!({ "quarantined_to": notice }),
    );
    *DB_RECOVERY.write() = Some(notice);
    Ok(())
}

/// A single rung of the numbered migration ladder. `version` is the
/// `PRAGMA user_version` value the DB advances to once `apply` succeeds; the
/// ladder runs every step whose version is greater than the current
/// `user_version`, in ascending order, each inside its own transaction.
///
/// Every `apply` body must be idempotent on its own — an old-shape DB sits at
/// `user_version = 0` even if some columns already exist (the pre-ladder
/// ad-hoc migrations never recorded a version), so a step may re-run against
/// a schema that already has its changes. `CREATE … IF NOT EXISTS` and the
/// `pragma_table_info` column guards keep that safe.
struct Migration {
    version: i64,
    apply: fn(&Connection) -> Result<()>,
}

/// Whether `table` has a column named `column`. Used by ladder steps to make
/// `ALTER TABLE ADD COLUMN` idempotent (SQLite has no `ADD COLUMN IF NOT
/// EXISTS`). `pub(crate)` so sibling modules folded into the ladder (e.g.
/// `rag::ensure_schema_rung`) can guard their own `ADD COLUMN` migrations the
/// same way.
pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let q = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1");
    match conn.query_row(&q, params![column], |_| Ok(true)) {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(anyhow::anyhow!(
            "pragma_table_info({table}.{column}) failed: {e}"
        )),
    }
}

/// The ordered migration ladder. The highest `version` here is the target
/// schema — both a fresh DB and any older DB converge to it. Steps must only
/// ever be appended; never reorder or renumber an existing rung.
const MIGRATIONS: &[Migration] = &[
    // v1 — base tables. The original schema before versioning existed.
    Migration {
        version: 1,
        apply: |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    model TEXT,
                    created_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
                 CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
                    source_msg_id INTEGER,
                    tags TEXT NOT NULL DEFAULT '',
                    embedding BLOB,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
                 CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conversation_id);",
            )?;
            Ok(())
        },
    },
    // v2 — messages.model: per-message model attribution.
    Migration {
        version: 2,
        apply: |conn| {
            if !column_exists(conn, "messages", "model")? {
                conn.execute("ALTER TABLE messages ADD COLUMN model TEXT", [])?;
            }
            Ok(())
        },
    },
    // v3 — messages.images: JSON-encoded `ChatImage[]` for vision attachments.
    Migration {
        version: 3,
        apply: ensure_messages_images_column,
    },
    // v4 — memories scope columns: scope ('global'|'project'|'conversation')
    // and project_root, plus the scope index.
    Migration {
        version: 4,
        apply: ensure_memory_scope_columns,
    },
    // v5 — conversation fork columns: parent_conv_id, parent_message_id and
    // the parent index — branch/fork lineage tracking.
    Migration {
        version: 5,
        apply: ensure_conversation_fork_columns,
    },
    // v6 — conversations.params: nullable JSON object of per-conversation
    // model params { temperature, top_p, max_tokens, system_prompt }.
    Migration {
        version: 6,
        apply: ensure_conversation_params_column,
    },
    // v7 — conversation organization: pinned (0/1) + tags (JSON array string).
    Migration {
        version: 7,
        apply: ensure_conversation_org_columns,
    },
    // v8 — Workflows feature: `workflows` + `workflow_runs` tables.
    Migration {
        version: 8,
        apply: crate::workflows::ensure_workflow_tables,
    },
    // v9 — `workflow_card_fired.workflow_id`: an INTEGER column so
    // `delete_workflow` can delete by equality rather than a `card_key LIKE
    // '<id>:%'` pattern that would over-match (e.g. for id=1 a row keyed
    // `10:foo` was a false positive). Backfills the column by parsing the
    // integer prefix out of each existing card_key.
    Migration {
        version: 9,
        apply: crate::workflows::ensure_card_fired_workflow_id_column,
    },
    // v10 — native image generation: `images` table tracking every
    // generated PNG (path on disk, prompt, params blob, optional owning
    // conversation). Listing is keyed on `(conv_id, created_at DESC)`.
    Migration {
        version: 10,
        apply: ensure_images_table,
    },
    // v11 — maturity-review indexing pass. Adds the indexes the
    // 2026-05-25 review flagged as missing on hot read paths: composite
    // index on (conversation_id, created_at DESC) for messages so the
    // chat scroll-back doesn't re-sort post-read; (status, content) on
    // memories for the LIKE fallback path; (last_used_at DESC) on
    // memories for future LRU policy; (conversation_id, ts DESC) on
    // agent_audit so the per-conversation tool-history slide-out
    // doesn't full-scan the audit log. All `IF NOT EXISTS` so re-running
    // is a no-op.
    Migration {
        version: 11,
        apply: |conn| {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_conv_created
                    ON messages(conversation_id, created_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_memories_status_content
                    ON memories(status, content);
                 CREATE INDEX IF NOT EXISTS idx_memories_last_used
                    ON memories(last_used_at DESC);",
            )?;
            // agent_audit may not exist yet on a brand-new DB if the
            // first audit row hasn't been written; guard with table
            // existence so the migration doesn't error.
            let has_audit: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type='table' AND name='agent_audit'",
                [],
                |r| r.get(0),
            )?;
            if has_audit == 1 {
                conn.execute_batch(
                    "CREATE INDEX IF NOT EXISTS idx_agent_audit_conv_ts
                        ON agent_audit(conversation_id, ts DESC);",
                )?;
            }
            Ok(())
        },
    },
    // v12 — agent_audit gains a `workflow_run_id` column so workflow-driven
    // tool calls can be filtered out of the per-conversation audit view and
    // correlated back to the run that produced them. Older DBs need a
    // schema-level ALTER; fresh DBs pick up the column via
    // `agent_audit::ensure_schema`'s CREATE TABLE. (Tier 3 audit, 2026-05-26.)
    Migration {
        version: 12,
        apply: |conn| {
            let has_audit: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type='table' AND name='agent_audit'",
                [],
                |r| r.get(0),
            )?;
            if has_audit == 1 {
                let already_has_col: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agent_audit') \
                         WHERE name='workflow_run_id'",
                    [],
                    |r| r.get(0),
                )?;
                if already_has_col == 0 {
                    conn.execute_batch(
                        "ALTER TABLE agent_audit ADD COLUMN workflow_run_id INTEGER;",
                    )?;
                }
                conn.execute_batch(
                    "CREATE INDEX IF NOT EXISTS idx_agent_audit_workflow_run
                        ON agent_audit(workflow_run_id);",
                )?;
            }
            Ok(())
        },
    },
    // v13 — additional indexes (must run after v12 because it references
    // the same agent_audit table the v12 column ALTER touches).
    Migration {
        version: 13,
        apply: |conn| {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_memories_created
                    ON memories(created_at DESC);",
            )?;
            let has_audit: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type='table' AND name='agent_audit'",
                [],
                |r| r.get(0),
            )?;
            if has_audit == 1 {
                conn.execute_batch(
                    "CREATE INDEX IF NOT EXISTS idx_agent_audit_ts_id
                        ON agent_audit(ts DESC, id DESC);",
                )?;
            }
            Ok(())
        },
    },
    // v14 — Procedural memory: `workflow_skills` lets a workflow save named
    // reusable `(tool, args)` sequences that future agent runs can list,
    // inspect, invoke, or delete. `workflow_skills_history` is a shadow
    // table that captures the prior row on every overwrite, capped to 50
    // entries per (workflow_id, name) so the audit trail can't grow
    // unbounded. ON DELETE CASCADE on `workflow_id` so dropping a workflow
    // also drops its skills (history rows are not cascaded — they carry
    // workflow_id but no FK, intentionally, so a deleted workflow's
    // history survives long enough for forensics if needed; the production
    // delete-workflow path doesn't keep them, see workflow_skills::delete).
    Migration {
        version: 14,
        apply: crate::workflow_skills::ensure_workflow_skills_tables,
    },
    // v15 — Claude Skills library. A global (not workflow-scoped) catalog of
    // Anthropic-format skill folders the user has imported. Each row carries
    // the full `SKILL.md` body, the parsed frontmatter, and two toggles:
    // `enabled` (advertised in the agent's tool-stub catalog) and `pinned`
    // (full body_md prepended to the system prompt at chat start). `name` is
    // globally UNIQUE so the agent can address a skill by name alone.
    Migration {
        version: 15,
        apply: crate::claude_skills::ensure_claude_skills_tables,
    },
    // v16 — was the LoRA pre-merge pipeline (`lora_merges`). That feature
    // was removed as dead code; this rung is now a no-op so fresh DBs never
    // create the table, and v19 drops it from any DB that already has it.
    Migration {
        version: 16,
        apply: |_| Ok(()),
    },
    // v17 — Roundtable OUTCOMES: the `roundtable_runs` table persists completed
    // roundtable transcripts (config + turns + totals) so an outcome survives
    // navigation AND app restart and can be reopened / exported later.
    Migration {
        version: 17,
        apply: crate::roundtable::ensure_roundtable_tables,
    },
    // v18 — full-text message search (product review Act 2, 2026-06-10).
    // External-content FTS5 table over messages.content with sync triggers
    // and a one-time rebuild, so "where did we discuss X" lands on the
    // MESSAGE (BM25-ranked, snippeted) instead of a bare conversation list.
    Migration {
        version: 18,
        apply: ensure_messages_fts,
    },
    // v19 — drop the vestigial `lora_merges` table (the LoRA pre-merge
    // feature was removed). DBs created before this rung carry an empty,
    // never-read table; this removes it so nothing remains on disk.
    Migration {
        version: 19,
        apply: |conn| {
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_lora_merges_lru;
                 DROP TABLE IF EXISTS lora_merges;",
            )?;
            Ok(())
        },
    },
    // v20 — fold the agent_audit schema into the ladder (consolidation pass,
    // 2026-06-13). `agent_audit::ensure_schema` is already idempotent
    // (CREATE TABLE/INDEX IF NOT EXISTS); calling it from the rung body means
    // a fresh DB picks up the audit tables in version order rather than from a
    // post-ladder DDL block. The `pub(crate)` fn is kept so its unit tests
    // (which drive an isolated in-memory connection) still compile + pass.
    Migration {
        version: 20,
        apply: crate::agent_audit::ensure_schema,
    },
    // v21 — fold the RAG schema into the ladder. `rag::ensure_schema_rung`
    // runs the CREATE…IF NOT EXISTS block AND replaces the old bare
    // `let _ = ALTER…ADD COLUMN embedder` with a `column_exists`-guarded
    // ALTER so the migration surfaces a real error rather than silently
    // swallowing one.
    Migration {
        version: 21,
        apply: crate::rag::ensure_schema_rung,
    },
    // v22 — move the `model_perf_samples` table + `idx_perf_model` out of the
    // post-ladder DDL block in `setup_schema` into a rung (identical SQL).
    Migration {
        version: 22,
        apply: |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS model_perf_samples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    backend TEXT NOT NULL,
                    ttft_ms INTEGER NOT NULL,
                    tok_per_sec REAL NOT NULL,
                    completion_tokens INTEGER NOT NULL,
                    cold_load INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX IF NOT EXISTS idx_perf_model ON model_perf_samples(model, ts);",
            )?;
            Ok(())
        },
    },
    // v23 — index supporting the new agent_session_metrics cap (WS4 maintenance
    // agent: a contiguous primary-key range delete keeping the newest N rows,
    // mirroring agent_audit's trim). The `(ts DESC, id DESC)` shape matches
    // `idx_agent_audit_ts_id` so the cap's "newest by id" selection is cheap.
    // agent_session_metrics is created in v20, so the table always exists here.
    Migration {
        version: 23,
        apply: |conn| {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_agent_session_metrics_ts_id
                    ON agent_session_metrics(ts DESC, id DESC);",
            )?;
            Ok(())
        },
    },
    // v24 — conversation_id reconciliation for agent_audit. The legacy
    // `conversation_id` column is TEXT (the frontend passes the conv id as a
    // string over IPC); we DO NOT change its type. Instead we add an additive
    // sibling `conv_id INTEGER` with an inline FK to conversations(id) ON
    // DELETE SET NULL, best-effort backfill it from the numeric-valid TEXT
    // values, and index it. `record` writes both columns going forward; reads
    // keep matching the TEXT column so the IPC contract is unchanged.
    Migration {
        version: 24,
        apply: |conn| {
            if !column_exists(conn, "agent_audit", "conv_id")? {
                add_conv_id_column(conn, "agent_audit")?;
                backfill_conv_id(conn, "agent_audit")?;
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_agent_audit_conv_id
                    ON agent_audit(conv_id);",
            )?;
            Ok(())
        },
    },
    // v25 — same reconciliation for agent_session_metrics. Note its legacy
    // `conversation_id` is `TEXT NOT NULL`; the new `conv_id` is nullable
    // INTEGER (NULL when the legacy value isn't a live numeric conversation
    // id), so the additive sibling never breaks the NOT NULL on the old column.
    Migration {
        version: 25,
        apply: |conn| {
            if !column_exists(conn, "agent_session_metrics", "conv_id")? {
                add_conv_id_column(conn, "agent_session_metrics")?;
                backfill_conv_id(conn, "agent_session_metrics")?;
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_agent_session_metrics_conv_id
                    ON agent_session_metrics(conv_id);",
            )?;
            Ok(())
        },
    },
    // v26 — sqlite-vec ANN index for RAG. Creates the `vec_rag_chunks` vec0
    // virtual table at the dim inferred from existing `rag_chunks` BLOBs
    // (length/4) and backfills it. Best-effort + GUARDED: if vec0 isn't linked
    // (`vec_version()` fails) this rung logs a diag and returns Ok WITHOUT
    // creating the table — the app still works via the linear fallback, and the
    // runtime `ensure_vec_tables_present()` (run after setup_schema on every
    // boot) idempotently creates + backfills it once vec0 becomes available.
    // user_version advances regardless, which is why the runtime backfill
    // exists. BLOB columns stay the source of truth; vec0 is a rebuildable
    // derived index.
    Migration {
        version: 26,
        apply: |conn| {
            if !vec0_available() {
                crate::diagnostics::info(
                    "migration",
                    "v26: vec0 unavailable — skipping vec_rag_chunks (linear fallback in use; \
                     runtime backfill will create it if vec0 appears)",
                );
                return Ok(());
            }
            if table_exists(conn, "rag_chunks")? {
                if let Some(dim) = infer_dim(conn, "rag_chunks", "1=1") {
                    ensure_vec_table(conn, VEC_RAG_CHUNKS, dim)?;
                    backfill_vec_rag(conn, dim)?;
                }
            }
            Ok(())
        },
    },
    // v27 — sqlite-vec ANN index for memory. Same shape as v26 for the
    // `memories` table (only rows with a non-null embedding are indexable;
    // status is filtered at read time, so all non-null embeddings are indexed).
    Migration {
        version: 27,
        apply: |conn| {
            if !vec0_available() {
                crate::diagnostics::info(
                    "migration",
                    "v27: vec0 unavailable — skipping vec_memories (linear fallback in use; \
                     runtime backfill will create it if vec0 appears)",
                );
                return Ok(());
            }
            if table_exists(conn, "memories")? {
                if let Some(dim) = infer_dim(conn, "memories", "embedding IS NOT NULL") {
                    ensure_vec_table(conn, VEC_MEMORIES, dim)?;
                    backfill_vec_memories(conn, dim)?;
                }
            }
            Ok(())
        },
    },
    // v28 — durable per-iteration agent checkpointing (item 4 half A). Adds four
    // nullable, additive columns to `messages` so an interactive agent run can
    // persist each iteration's assistant/tool turns AS they settle (rather than
    // only the final answer), plus an index on (run_id, turn_index) so the
    // checkpoint command's idempotent upserts and any future resume read are
    // cheap. All columns are nullable and column_exists-guarded — old rows and
    // every non-agent message keep them NULL, so the schema change is fully
    // additive and backward-compatible. (Recovery/auto-resume on reload is
    // intentionally DEFERRED; only the durable write half lands here.)
    Migration {
        version: 28,
        apply: |conn| {
            if !column_exists(conn, "messages", "tool_call_id")? {
                conn.execute("ALTER TABLE messages ADD COLUMN tool_call_id TEXT", [])?;
            }
            if !column_exists(conn, "messages", "tool_name")? {
                conn.execute("ALTER TABLE messages ADD COLUMN tool_name TEXT", [])?;
            }
            if !column_exists(conn, "messages", "run_id")? {
                conn.execute("ALTER TABLE messages ADD COLUMN run_id TEXT", [])?;
            }
            if !column_exists(conn, "messages", "turn_index")? {
                conn.execute("ALTER TABLE messages ADD COLUMN turn_index INTEGER", [])?;
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_run_turn
                    ON messages(run_id, turn_index);",
            )?;
            Ok(())
        },
    },
    // v29 — UNIQUE index on (conversation_id, run_id, turn_index) so
    // `checkpoint_run` can switch from delete-all-then-reinsert (O(K²) row
    // writes + FTS-trigger churn across a long agent run) to an incremental
    // `INSERT … ON CONFLICT … DO UPDATE` keyed on this triple. Scoped by
    // conversation_id so a run_id collision across conversations can't conflict
    // (mirrors the old DELETE's (conv_id, run_id) scope). Normal messages have
    // run_id IS NULL; SQLite treats NULLs as distinct in a UNIQUE index, so the
    // unbounded set of (conv, NULL, NULL) visible rows is unconstrained.
    Migration {
        version: 29,
        apply: |conn| {
            conn.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conv_run_turn
                    ON messages(conversation_id, run_id, turn_index);",
            )?;
            Ok(())
        },
    },
    // v30 — RESUME: a `run_done` flag on checkpoint shadow rows so a finished /
    // dismissed run won't be re-offered for resume (item: resume an interrupted
    // long run). Additive + nullable: every existing row (and every non-agent
    // message) keeps it NULL, which the reader treats as "open" for any run that
    // has shadow rows — i.e. an upgrade preserves the prior durable checkpoints
    // exactly, and a run interrupted across the upgrade is still resumable. New
    // checkpoint writes set `run_done = 0` explicitly; `close_run` flips a run's
    // rows to 1. Index on (conversation_id, run_done) keeps the "most recent
    // unfinished run for this conversation" probe cheap. Forward-only: no stored
    // checkpoint/conversation/memory data is rewritten or destroyed.
    Migration {
        version: 30,
        apply: |conn| {
            if !column_exists(conn, "messages", "run_done")? {
                conn.execute("ALTER TABLE messages ADD COLUMN run_done INTEGER", [])?;
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_conv_run_done
                    ON messages(conversation_id, run_done);",
            )?;
            Ok(())
        },
    },
    // v31 — Skills & Tools hub: a free-text `category` on `claude_skills` so the
    // hub can group imported skills. Forward-only + nullable: every existing row
    // keeps it NULL, which readers COALESCE to "General"; new/overwritten
    // imports persist the parsed `category:` frontmatter. The rung is idempotent
    // (column_exists-guarded ADD COLUMN) and re-runnable against a fresh DB whose
    // `ensure_claude_skills_tables` already created the column. No stored data is
    // rewritten or destroyed.
    Migration {
        version: 31,
        apply: crate::claude_skills::ensure_claude_skills_category_column,
    },
    // v32 — repair the messages_fts DELETE/UPDATE triggers. v18 created `_ad`
    // and `_au` WITHOUT the `run_id IS NULL` guard the INSERT trigger (`_ai`,
    // hardened in v28) carries. Because `ensure_messages_fts` uses CREATE
    // TRIGGER IF NOT EXISTS, an existing DB kept the OLD unguarded triggers — so
    // deleting/editing a v28 checkpoint shadow row issued an external-content
    // FTS5 'delete' command for a posting that was never inserted, pushing the
    // index toward "database disk image is malformed". This rung DROPs both
    // triggers and recreates them with the guards (`old.run_id IS NULL` on _ad,
    // `new.run_id IS NULL` on _au), then runs `INSERT INTO
    // messages_fts(messages_fts) VALUES('rebuild')` ONCE to rebuild the
    // external-content index from the live `messages` rows — repairing any
    // inconsistency a prior unguarded delete-posting introduced. Forward-only +
    // idempotent: DROP IF EXISTS + CREATE IF NOT EXISTS, and `rebuild` is a pure
    // re-derivation of the index (no stored message/checkpoint data is rewritten
    // or destroyed). A fresh DB already has the guarded triggers from the v18
    // rung, so re-running this rung against it just re-asserts them + rebuilds.
    Migration {
        version: 32,
        apply: |conn| {
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS messages_fts_ad;
                 DROP TRIGGER IF EXISTS messages_fts_au;
                 CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
                 WHEN old.run_id IS NULL BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                 END;
                 CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages
                 WHEN new.run_id IS NULL BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
                 END;
                 INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');",
            )?;
            Ok(())
        },
    },
];

/// Add the additive `conv_id INTEGER` sibling column to `table`, preferring an
/// inline `REFERENCES conversations(id) ON DELETE SET NULL` so the DB enforces
/// the null-on-parent-delete invariant. SQLite permits a FOREIGN KEY clause on
/// `ADD COLUMN` only when the new column's default is NULL (ours is). If a
/// given SQLite build rejects the FK-on-add-column form we fall back to a plain
/// `INTEGER` column — the app layer (`delete_conversation`) still nulls these
/// siblings, so the SET-NULL contract holds either way.
fn add_conv_id_column(conn: &Connection, table: &str) -> Result<()> {
    let with_fk = format!(
        "ALTER TABLE {table} ADD COLUMN conv_id INTEGER \
         REFERENCES conversations(id) ON DELETE SET NULL"
    );
    if conn.execute_batch(&with_fk).is_ok() {
        return Ok(());
    }
    // Fallback: plain column, app-layer enforces SET-NULL.
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN conv_id INTEGER"))?;
    Ok(())
}

/// Best-effort backfill of the new `conv_id` from the legacy TEXT
/// `conversation_id`: parse only purely-numeric values that point at a live
/// conversation. Non-numeric or orphaned-numeric values are left NULL. Idempotent
/// (only fills rows where `conv_id IS NULL`).
fn backfill_conv_id(conn: &Connection, table: &str) -> Result<()> {
    // `GLOB '[0-9]*'` only requires the string to START with a digit, and
    // `CAST(... AS INTEGER)` truncates at the first non-digit, so '12abc' would
    // map to conv_id=12 — a wrong FK to an unrelated conversation. Add a
    // whole-string numeric guard (`NOT GLOB '*[^0-9]*'` = no non-digit anywhere)
    // so only purely-numeric values are cast/matched, matching this function's
    // documented contract AND the live-write path's strict `parse::<i64>()`
    // (agent_audit::parse_conv_id).
    conn.execute_batch(&format!(
        "UPDATE {table} SET conv_id = CAST(conversation_id AS INTEGER)
         WHERE conv_id IS NULL
           AND conversation_id GLOB '[0-9]*'
           AND conversation_id NOT GLOB '*[^0-9]*'
           AND CAST(conversation_id AS INTEGER) IN (SELECT id FROM conversations);"
    ))?;
    Ok(())
}

/// Target schema version — the highest rung of the ladder.
#[cfg(test)]
fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

/// Run the migration ladder against `conn`. Steps whose `version` exceeds the
/// DB's current `PRAGMA user_version` are applied in ascending order, each in
/// its own transaction; `user_version` is advanced after each rung commits.
/// Running this against an up-to-date DB is a no-op.
fn run_migrations(conn: &Connection) -> Result<()> {
    let mut current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // Data-layer audit C3 (2026-05-24): refuse to open a DB whose schema is
    // newer than anything this binary knows. A user who auto-updated, used
    // v12 schema, then rolled back to v10 (e.g. release-channel switch,
    // crash-recovery via Time Machine) would otherwise silently degrade —
    // SELECTs survive named columns, but the next INSERT into a table with
    // a new NOT NULL column hard-fails with a generic error. Bail early
    // with an actionable message instead.
    let latest = MIGRATIONS.iter().map(|m| m.version).max().unwrap_or(0);
    if current > latest {
        anyhow::bail!(
            "database schema is at version {} but this Froglips build only knows up to v{}. \
             Upgrade Froglips before re-opening this database.",
            current,
            latest
        );
    }
    for m in MIGRATIONS {
        if m.version <= current {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        let stepped = (|| -> Result<()> {
            (m.apply)(conn)?;
            // `user_version` cannot be parameterised — the value is a ladder
            // constant, never user input, so the format is safe.
            conn.execute_batch(&format!("PRAGMA user_version = {}", m.version))?;
            Ok(())
        })();
        match stepped {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                current = m.version;
            }
            Err(e) => {
                // 2026-05-25 SE review: silent rollback failure could leave
                // the DB in a half-migrated state with no operator signal.
                // Route through diagnostics so a partial-migration
                // corruption risk surfaces in the rolling log + UI panel.
                if let Err(rb_err) = conn.execute_batch("ROLLBACK") {
                    crate::diagnostics::error_with(
                        "migration",
                        &format!(
                            "ROLLBACK after failed migration to v{} ALSO failed: {} \
                             (DB may be in a partially-migrated state)",
                            m.version, rb_err
                        ),
                        serde_json::json!({
                            "version": m.version,
                            "rollback_error": rb_err.to_string(),
                            "original_error": e.to_string(),
                        }),
                    );
                }
                return Err(e.context(format!("migration to v{} failed", m.version)));
            }
        }
    }
    Ok(())
}

fn setup_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    // Numbered migration ladder keyed on PRAGMA user_version. A fresh DB runs
    // every rung from 0; an existing DB runs only the rungs above its recorded
    // version. Both converge on `latest_version()`.
    //
    // Consolidation pass (2026-06-13): the agent_audit, RAG and
    // model_perf_samples schemas used to be installed by post-ladder DDL
    // blocks here. They're now ladder rungs (v20-v22), so `setup_schema` is
    // exactly `run_migrations` plus the connection pragmas — every schema
    // object lands in version order and `assert_final_schema` covers them.
    run_migrations(conn)?;
    Ok(())
}

/// v18: external-content FTS5 index over `messages.content`. Triggers keep it
/// in sync with INSERT/DELETE/UPDATE; `rebuild` backfills existing rows once.
/// External-content keeps the index small (it references messages.rowid
/// instead of duplicating bodies).
pub(crate) fn ensure_messages_fts(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='id',
            tokenize='porter unicode61'
         );
         -- v28 agent checkpoint rows carry a non-null run_id (durable shadow of
         -- in-flight agent state). They must NOT be indexed: list_messages hides
         -- them, so surfacing them in message search would break the v28 'visible
         -- conversation is unchanged' invariant and leak transient tool-result
         -- text the user never sees. `WHEN new.run_id IS NULL` keeps shadows out
         -- of the index. (Query-side run_id filters in search_messages_fts /
         -- search_messages are the robust backstop, since `rebuild`/optimize
         -- re-scan all rows regardless of this trigger guard.)
         --
         -- The DELETE/UPDATE triggers carry the MATCHING guard: a shadow row was
         -- never inserted into the index, so issuing the external-content FTS5
         -- delete command for it would push a delete-posting with no matching
         -- insert — which corrupts an external-content index (a later integrity
         -- check / query can hit a malformed-disk-image error). `_ad`
         -- guards on `old.run_id IS NULL`; `_au` on `new.run_id IS NULL` (an
         -- UPDATE OF content never changes run_id, so old/new agree). A row that
         -- toggled across the NULL boundary is handled by the v18 INSERT/DELETE
         -- pair, not content UPDATEs. (Older DBs created the unguarded _ad/_au;
         -- the v32 rung drops+recreates them and runs one `rebuild` to repair.)
         CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
         WHEN new.run_id IS NULL BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
         END;
         CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
         WHEN old.run_id IS NULL BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
         END;
         CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages
         WHEN new.run_id IS NULL BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
         END;
         INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');",
    )?;
    Ok(())
}

/// One full-text hit for the Knowledge → History search. (Distinct from the
/// sidebar's LIKE-based conversation-level `MessageSearchHit` below.)
#[derive(serde::Serialize, Clone, Debug)]
pub struct FtsMessageHit {
    pub message_id: i64,
    pub conversation_id: i64,
    pub conversation_title: String,
    pub role: String,
    pub created_at: i64,
    /// snippet() output with [ ] markers around matched terms.
    pub snippet: String,
}

/// BM25-ranked message search. The raw user query is wrapped per-token in
/// double quotes so FTS5 operators (AND/OR/NEAR/^/*) in user text can't
/// inject query syntax errors — every token is a plain phrase term.
pub fn search_messages_fts(query: &str, limit: u32) -> Result<Vec<FtsMessageHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let safe: Vec<String> = trimmed
        .split_whitespace()
        .take(12)
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();
    if safe.is_empty() {
        return Ok(Vec::new());
    }
    let fts_query = safe.join(" ");
    let limit = limit.clamp(1, 100) as i64;

    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT m.id, m.conversation_id, c.title, m.role, m.created_at,
                snippet(messages_fts, 0, '[', ']', '…', 12)
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?1
           AND m.run_id IS NULL
         ORDER BY bm25(messages_fts)
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![fts_query, limit], |r| {
        Ok(FtsMessageHit {
            message_id: r.get(0)?,
            conversation_id: r.get(1)?,
            conversation_title: r.get(2)?,
            role: r.get(3)?,
            created_at: r.get(4)?,
            snippet: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[derive(serde::Deserialize, Debug)]
pub struct PerfSample {
    pub model: String,
    pub backend: String,
    pub ttft_ms: i64,
    pub tok_per_sec: f64,
    pub completion_tokens: i64,
    pub cold_load: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct PerfSummaryRow {
    pub model: String,
    pub backend: String,
    pub samples: i64,
    pub avg_tok_per_sec: f64,
    /// Warm-only average — cold loads excluded so a reload doesn't read as a
    /// slow model.
    pub avg_ttft_ms: f64,
    pub last_ts: i64,
}

pub fn model_perf_record(s: &PerfSample) -> Result<()> {
    // WS3: single-writer gate. The INSERT + periodic trim share the txn.
    with_write(|tx| {
        tx.execute(
            "INSERT INTO model_perf_samples (ts, model, backend, ttft_ms, tok_per_sec, completion_tokens, cold_load)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![now_unix(), s.model, s.backend, s.ttft_ms, s.tok_per_sec, s.completion_tokens, s.cold_load as i64],
        )?;
        // Bound the ledger: keep the most recent ~5000 samples. Perf (low):
        // model_perf_record fires once per generated reply, so pruning on every
        // INSERT runs an `ORDER BY id DESC LIMIT 5000` walk + no-op DELETE + WAL
        // touch even when the table is far under the cap. Only prune periodically
        // (every 256th insert) — the cap stays effectively honoured (we never
        // exceed 5000 + ~255) without paying the prune cost on the common path.
        if (tx.last_insert_rowid() as u64).is_multiple_of(256) {
            tx.execute(
                "DELETE FROM model_perf_samples WHERE id < (
                    SELECT COALESCE(MIN(id), 0) FROM (
                        SELECT id FROM model_perf_samples ORDER BY id DESC LIMIT 5000
                    )
                 )",
                [],
            )?;
        }
        Ok(())
    })
}

pub fn model_perf_summary() -> Result<Vec<PerfSummaryRow>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT model, backend, COUNT(*),
                AVG(tok_per_sec),
                AVG(CASE WHEN cold_load = 0 THEN ttft_ms END),
                MAX(ts)
         FROM model_perf_samples
         GROUP BY model, backend
         ORDER BY MAX(ts) DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PerfSummaryRow {
            model: r.get(0)?,
            backend: r.get(1)?,
            samples: r.get(2)?,
            avg_tok_per_sec: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            avg_ttft_ms: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
            last_ts: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Idempotently add the `images` JSON column to the `messages` table. Detects
/// via `pragma_table_info` so re-runs on an upgraded schema are no-ops.
pub(crate) fn ensure_messages_images_column(conn: &Connection) -> Result<()> {
    let has: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'images'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("pragma_table_info(images) failed: {e}")),
    };
    if !has {
        conn.execute("ALTER TABLE messages ADD COLUMN images TEXT", [])?;
    }
    Ok(())
}

/// Idempotently add scope columns to the `memories` table. Detects each
/// column via `pragma_table_info` before running `ALTER TABLE`.
pub(crate) fn ensure_memory_scope_columns(conn: &Connection) -> Result<()> {
    let has_col = |name: &str| -> Result<bool> {
        match conn.query_row(
            "SELECT 1 FROM pragma_table_info('memories') WHERE name = ?1",
            params![name],
            |_| Ok(true),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(anyhow::anyhow!("pragma_table_info failed: {e}")),
        }
    };
    if !has_col("scope")? {
        conn.execute(
            "ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
            [],
        )?;
    }
    if !has_col("project_root")? {
        conn.execute("ALTER TABLE memories ADD COLUMN project_root TEXT", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)",
        [],
    )?;
    Ok(())
}

/// Idempotently add fork tracking columns to the `conversations` table.
/// Detects each column via `pragma_table_info` before running `ALTER TABLE`.
pub(crate) fn ensure_conversation_fork_columns(conn: &Connection) -> Result<()> {
    let has_col = |name: &str| -> Result<bool> {
        match conn.query_row(
            "SELECT 1 FROM pragma_table_info('conversations') WHERE name = ?1",
            params![name],
            |_| Ok(true),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(anyhow::anyhow!("pragma_table_info failed: {e}")),
        }
    };
    if !has_col("parent_conv_id")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN parent_conv_id INTEGER",
            [],
        )?;
    }
    if !has_col("parent_message_id")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN parent_message_id INTEGER",
            [],
        )?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conv_id)",
        [],
    )?;
    // One-time cleanup of dangling parent refs left over from before
    // `delete_conversation` cascaded fork parentage. Without this sweep,
    // a DB upgraded from a pre-cascade version can still surface
    // "parent conversation not found" errors in the fork tree. Idempotent:
    // re-running it on a clean DB updates zero rows.
    conn.execute(
        "UPDATE conversations
         SET parent_conv_id = NULL, parent_message_id = NULL
         WHERE parent_conv_id IS NOT NULL
           AND parent_conv_id NOT IN (SELECT id FROM conversations)",
        [],
    )?;
    Ok(())
}

/// Idempotently add the `params` JSON column to the `conversations` table.
/// Detects via `pragma_table_info` so re-runs on an upgraded schema are no-ops.
pub(crate) fn ensure_conversation_params_column(conn: &Connection) -> Result<()> {
    let has: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'params'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("pragma_table_info(params) failed: {e}")),
    };
    if !has {
        conn.execute("ALTER TABLE conversations ADD COLUMN params TEXT", [])?;
    }
    Ok(())
}

/// Idempotently add the conversation-organization columns to `conversations`:
/// `pinned` (INTEGER 0/1, default 0) and `tags` (nullable TEXT holding a JSON
/// array of strings). Detects each column via `pragma_table_info` first.
pub(crate) fn ensure_conversation_org_columns(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "conversations", "pinned")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(conn, "conversations", "tags")? {
        conn.execute("ALTER TABLE conversations ADD COLUMN tags TEXT", [])?;
    }
    Ok(())
}

/// Idempotently create the `images` table + composite listing index used by
/// the native image-generation backend. `conv_id` is nullable so generations
/// initiated outside any conversation (the dedicated image-gen surface) still
/// have a home. `params_json` mirrors the same blob embedded in the PNG tEXt
/// chunk so listing doesn't have to crack the file open.
pub(crate) fn ensure_images_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conv_id INTEGER NULL REFERENCES conversations(id) ON DELETE SET NULL,
            model TEXT NOT NULL,
            prompt TEXT NOT NULL,
            params_json TEXT NOT NULL,
            path TEXT NOT NULL,
            width INTEGER,
            height INTEGER,
            seed INTEGER,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_images_conv_created
             ON images(conv_id, created_at DESC);
         -- R2-M4 (2026-05-28): single-column reverse index for
         -- global-scope (`conv_id IS NULL`) top-N queries. The composite
         -- index above only helps when `conv_id` is bound; the global
         -- ImageView pagination (the most common scope on a long-running
         -- gallery) needs a tight index on `created_at` alone.
         CREATE INDEX IF NOT EXISTS idx_images_created_desc
             ON images(created_at DESC);",
    )?;
    Ok(())
}

fn build_pool() -> Result<Pool<SqliteManager>> {
    // CRITICAL: register the vec0 auto-extension BEFORE any connection opens —
    // including the integrity probe + schema connection below — so every
    // connection in the process can use vec0 virtual tables.
    register_vec0_once();
    let path = db_path()?;
    // Corruption recovery: probe the existing DB before any pooled connection
    // touches it. A failed integrity check quarantines the file so schema
    // setup recreates a fresh DB instead of panicking the whole app.
    if !integrity_ok(&path) {
        quarantine_corrupt_db(&path)?;
    }
    {
        let conn = Connection::open(&path).context("schema setup connection")?;
        setup_schema(&conn)?;
        // Probe vec0 availability on the schema connection and record it. A
        // build/link without vec0 (or an SQLite too old) leaves VEC0_AVAILABLE
        // false → every vector query uses the preserved linear fallback.
        match conn.query_row("SELECT vec_version()", [], |r| r.get::<_, String>(0)) {
            Ok(ver) => {
                VEC0_AVAILABLE.store(true, Ordering::Relaxed);
                crate::diagnostics::info("db", &format!("sqlite-vec available: {ver}"));
            }
            Err(e) => {
                VEC0_AVAILABLE.store(false, Ordering::Relaxed);
                crate::diagnostics::warn_with(
                    "db",
                    "sqlite-vec (vec0) unavailable — vector search uses linear fallback",
                    serde_json::json!({ "error": e.to_string() }),
                );
            }
        }
        // Runtime backfill: user_version advances even when the vec0 rungs were
        // skipped (guarded best-effort), so idempotently create + backfill any
        // missing vec tables here on every boot.
        if let Err(e) = ensure_vec_tables_present(&conn) {
            crate::diagnostics::warn_with(
                "db",
                "ensure_vec_tables_present failed (non-fatal; linear fallback active)",
                serde_json::json!({ "error": e.to_string() }),
            );
        }
    }
    let manager = SqliteManager { path };
    // Pool sized for concurrent IPC handlers + background workers (scheduler,
    // restart-watcher, agent loop, MCP, RAG). The previous cap of 4 was
    // routinely exhausted under realistic concurrency; 16 keeps short-lived
    // reads from queueing behind a slow write while still bounding open fds.
    Pool::builder()
        .max_size(16)
        .build(manager)
        .map_err(|e| anyhow::anyhow!("pool build failed: {e}"))
}

pub(crate) fn get_db() -> Result<PooledConnection<SqliteManager>> {
    match &*DB {
        Ok(pool) => pool.get().context("db pool exhausted"),
        // Pool build failed at startup — surface the captured reason rather
        // than panicking. Callers map this into IPC errors / UI banners.
        Err(e) => Err(anyhow::anyhow!("db unavailable: {e}")),
    }
}

/// Test-only DB accessor — pulls a pooled connection through the same code
/// path as `get_db` so tests can run raw SQL against the real DB. Not part
/// of the IPC surface.
#[cfg(test)]
pub fn __test_get_db() -> Result<PooledConnection<SqliteManager>> {
    get_db()
}

/// Test-only: run the full migration ladder against an isolated connection so
/// sibling modules (rag/memory vec0 tests) can build a real-schema in-memory DB
/// without touching the global pool.
#[cfg(test)]
pub(crate) fn __test_run_migrations(conn: &Connection) -> Result<()> {
    run_migrations(conn)
}

pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* ── Single-writer serialization (WS3) ── */

/// Process-wide write gate. SQLite under WAL allows exactly one writer at a
/// time; concurrent writers from the 16-slot pool otherwise collide and the
/// loser retries (busy_timeout) or fails (SQLITE_BUSY_SNAPSHOT on a DEFERRED
/// promotion). Funnelling every writer through one in-process mutex turns that
/// contention into an orderly queue: writers serialize cleanly, and — crucially
/// — READERS never touch this lock, so read latency is unchanged.
static WRITE_LOCK: Lazy<parking_lot::Mutex<()>> = Lazy::new(|| parking_lot::Mutex::new(()));

/// Run a write closure as a single serialized IMMEDIATE transaction.
///
/// Acquisition order is deliberate: pull a pooled connection FIRST, then take
/// the write lock, then open the IMMEDIATE transaction. Locking before grabbing
/// a connection could let a writer hold the global lock while blocked waiting
/// for a pool slot, stalling every other writer behind an I/O wait. Readers
/// don't take this lock at all.
///
/// CONTRACT — NON-REENTRANT: `parking_lot::Mutex` is not reentrant, so a closure
/// passed to `with_write` MUST NEVER call `with_write` again (directly or via
/// any helper that does), or the thread self-deadlocks. The connection-scoped
/// inner `*_in` / raw helpers exist precisely so a composite writer can run all
/// of its statements on the single transaction it already holds. Keep write
/// closures flat: one `with_write`, all writes inside it.
pub(crate) fn with_write<T, F>(f: F) -> Result<T>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
{
    let mut conn = get_db()?;
    let _guard = WRITE_LOCK.lock();
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let out = f(&tx)?;
    tx.commit()?;
    Ok(out)
}

/// Hold the single-writer lock for the duration of `f`, WITHOUT opening a
/// transaction. For the rare writer that must manage its own connection + txn —
/// e.g. the maintenance agent, which ATTACHes the archive DB (ATTACH cannot run
/// inside a transaction, and `with_write`'s own connection wouldn't see an
/// ATTACH done elsewhere) and then runs `BEGIN IMMEDIATE … COMMIT` on that same
/// connection. Same NON-REENTRANT contract as `with_write`: do not call either
/// from inside `f`.
pub(crate) fn with_write_lock<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let _guard = WRITE_LOCK.lock();
    f()
}

#[derive(Serialize, Clone)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub model: Option<String>,
    pub created_at: i64,
    /// Source conversation if this conv is a fork. None for root conversations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_conv_id: Option<i64>,
    /// Cutoff message id from the parent — messages with id <= this were
    /// deep-copied into this fork at creation time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<i64>,
    /// Raw JSON string of per-conversation model params, or `None` when unset.
    /// Shape: `{ temperature, top_p, max_tokens, system_prompt }` — the
    /// frontend `JSON.parse`s this and applies the values at inference time.
    pub params: Option<String>,
    /// Whether the conversation is pinned. Pinned conversations sort ahead of
    /// the rest in `list_conversations`.
    pub pinned: bool,
    /// Raw JSON-array-of-strings string of user tags, or `None` when unset.
    /// The frontend `JSON.parse`s this back into a string list.
    pub tags: Option<String>,
}

/// Direct-child branch summary, returned by `list_branches`.
#[derive(Serialize, Clone)]
pub struct BranchInfo {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub parent_message_id: Option<i64>,
}

/// Recursive tree node returned by `get_fork_tree`. Depth-capped to bound the
/// response — deeper descendants are silently truncated at the cap.
#[derive(Serialize, Clone)]
pub struct ForkTree {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub parent_conv_id: Option<i64>,
    pub parent_message_id: Option<i64>,
    pub children: Vec<ForkTree>,
}

#[derive(Serialize, Clone)]
pub struct Message {
    pub id: Option<i64>,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: Option<i64>,
    pub model: Option<String>,
    /// JSON-encoded `ChatImage[]` payload. `None` for plain-text messages.
    /// Frontend `JSON.parse`s this back into the `images` field on `Message`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<String>,
}

pub fn create_conversation(title: &str, model: Option<&str>) -> Result<i64> {
    // WS3: single-writer gate.
    with_write(|tx| {
        tx.execute(
            "INSERT INTO conversations (title, model, created_at) VALUES (?1, ?2, ?3)",
            params![title, model, now_unix()],
        )?;
        Ok(tx.last_insert_rowid())
    })
}

/// Hard cap on conversations returned to the sidebar in a single call.
/// Audit M3 (2026-05-27): the previous unbounded SELECT IPC'd the whole
/// table on every sidebar mount, which is a hidden cliff for users with
/// 10k+ conversations. The renderer can't usefully display that many
/// rows anyway. When truncated we log a diag so power users see the
/// signal and can switch to search/filter affordances.
pub const CONVERSATIONS_LIST_CAP: i64 = 5000;

pub fn list_conversations() -> Result<Vec<Conversation>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, model, created_at, parent_conv_id, parent_message_id, params,
                pinned, tags
         FROM conversations ORDER BY pinned DESC, created_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![CONVERSATIONS_LIST_CAP], row_to_conversation)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() as i64 == CONVERSATIONS_LIST_CAP {
        // The page is exactly at the cap — there may be more. Surface a
        // diag so the user knows; this is purely informational since
        // older conversations remain reachable via search.
        crate::diagnostics::warn_with(
            "history",
            &format!(
                "list_conversations truncated at {} rows; older conversations not surfaced in sidebar",
                CONVERSATIONS_LIST_CAP
            ),
            serde_json::Value::Null,
        );
    }
    Ok(rows)
}

pub fn delete_conversation(id: i64) -> Result<()> {
    // WS3: single-writer gate. All statements run on the one serialized
    // IMMEDIATE transaction `with_write` opens.
    with_write(|tx| {
    // SQLite ALTER TABLE can't add a FOREIGN KEY ... ON DELETE SET NULL to
    // an existing column, so do the cascade in the app layer: any
    // conversation whose `parent_conv_id` points at the deleted row has its
    // parent reference cleared. Without this, deleting a parent leaves
    // every descendant fork pointing at a non-existent id and the
    // fork-tree query (get_fork_tree / list_branches) surfaces "parent
    // conversation not found" errors. Run both updates + the final delete
    // in a single transaction so a crash can never leave dangling refs.
    tx.execute(
        "UPDATE conversations SET parent_conv_id = NULL, parent_message_id = NULL
         WHERE parent_conv_id = ?1",
        params![id],
    )?;
    // conversation_id reconciliation (WS2): the audit/metrics `conv_id` sibling
    // columns carry an inline `ON DELETE SET NULL` FK when the SQLite build
    // enforces FKs on ALTER-added columns, but we null them here too so the
    // invariant holds even on builds that don't — keeping the audit rows alive
    // (they're forensic) while clearing the dangling reference. These tables
    // only exist once their v20/v24/v25 rungs have run; on a brand-new DB
    // mid-migration the UPDATE would target a missing column, so each is
    // best-effort (a missing table/column is a benign no-op, not a failure that
    // would abort the user's delete).
    let _ = tx.execute(
        "UPDATE agent_audit SET conv_id = NULL WHERE conv_id = ?1",
        params![id],
    );
    let _ = tx.execute(
        "UPDATE agent_session_metrics SET conv_id = NULL WHERE conv_id = ?1",
        params![id],
    );
    tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
    })
}

/// Returns the conversation_id of the deleted message so callers can scope refresh events.
pub fn delete_message(id: i64) -> Result<i64> {
    // WS3: single-writer gate. The existence probe + delete share the txn.
    with_write(|tx| {
        // Idempotent: a double-click / retried IPC / concurrent delete from a
        // second window must be a benign no-op, not a hard error (matches
        // delete_conversation). Returns 0 (no conversation to refresh) when the
        // row is already gone.
        let conv_id: Option<i64> = tx
            .query_row(
                "SELECT conversation_id FROM messages WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(conv_id) = conv_id else {
            return Ok(0);
        };
        tx.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        Ok(conv_id)
    })
}

pub fn rename_conversation(id: i64, title: &str) -> Result<()> {
    // WS3: single-writer gate.
    with_write(|tx| {
        tx.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        Ok(())
    })
}

/// Map a `conversations` row (in the canonical 9-column projection) to a
/// `Conversation`. Shared by `list_conversations` and `get_conversation`.
fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        model: r.get(2)?,
        created_at: r.get(3)?,
        parent_conv_id: r.get(4)?,
        parent_message_id: r.get(5)?,
        params: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
        tags: r.get(8)?,
    })
}

/// Fetch a single conversation row by id, including its `params` JSON.
pub fn get_conversation(id: i64) -> Result<Conversation> {
    let conn = get_db()?;
    conn.query_row(
        "SELECT id, title, model, created_at, parent_conv_id, parent_message_id, params,
                pinned, tags
         FROM conversations WHERE id = ?1",
        params![id],
        row_to_conversation,
    )
    .context("conversation not found")
}

/// Validate a `tags` payload: either `None` (clears the column) or a string
/// holding a JSON array whose every element is a string. Anything else is
/// rejected so the column never holds a non-conforming value.
pub fn validate_tags_json(tags: Option<&str>) -> Result<()> {
    let Some(raw) = tags else { return Ok(()) };
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| anyhow::anyhow!("tags is not valid JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("tags must be a JSON array"))?;
    if arr.iter().any(|v| !v.is_string()) {
        return Err(anyhow::anyhow!("tags must be a JSON array of strings"));
    }
    Ok(())
}

/// Set the pinned flag on a conversation. Pinned conversations sort first.
pub fn set_conversation_pinned(id: i64, pinned: bool) -> Result<()> {
    // WS3: single-writer gate.
    with_write(|tx| {
        tx.execute(
            "UPDATE conversations SET pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )?;
        Ok(())
    })
}

/// Set (or clear, with `None`) a conversation's tags. `tags` must pass
/// `validate_tags_json` — a JSON array of strings, or null.
pub fn set_conversation_tags(id: i64, tags: Option<&str>) -> Result<()> {
    validate_tags_json(tags)?;
    // WS3: single-writer gate.
    with_write(|tx| {
        tx.execute(
            "UPDATE conversations SET tags = ?1 WHERE id = ?2",
            params![tags, id],
        )?;
        Ok(())
    })
}

/// A message-body search hit: the conversation the match lives in plus a short
/// snippet of the matching message for display.
#[derive(Serialize, Clone)]
pub struct MessageSearchHit {
    pub conversation_id: i64,
    pub title: String,
    pub snippet: String,
}

/// Maximum length (chars) of a search snippet returned by `search_messages`.
const SEARCH_SNIPPET_CHARS: usize = 160;

/// Escape `%`, `_` and the escape char itself for a SQL `LIKE` pattern, so a
/// user query containing wildcards matches literally. Paired with
/// `ESCAPE '\'` in the query.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Build a single-line snippet centred on the first occurrence of `needle`
/// within `content`, capped at `SEARCH_SNIPPET_CHARS`. Case-insensitive match.
fn make_snippet(content: &str, needle: &str) -> String {
    let collapsed: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= SEARCH_SNIPPET_CHARS {
        return collapsed;
    }
    // Case-insensitive match in CHAR space. The old approach (byte offset of
    // the hit in `collapsed.to_lowercase()`, then slice the ORIGINAL-case
    // `collapsed` by that offset) was UNSOUND: some chars change byte/char
    // length when lowercased — e.g. Turkish 'İ' (U+0130) → "i̇" (2 chars) —
    // which misaligns the offset and panics on a non-boundary slice. Matching
    // per-char on the already-collected `chars` avoids any byte indexing.
    // MED (2026-05-30).
    let needle_chars: Vec<char> = needle.chars().collect();
    let hit_char = if needle_chars.is_empty() || needle_chars.len() > chars.len() {
        0
    } else {
        chars
            .windows(needle_chars.len())
            .position(|w| {
                w.iter()
                    .zip(&needle_chars)
                    .all(|(c, n)| c.to_lowercase().eq(n.to_lowercase()))
            })
            .unwrap_or(0)
    };
    let start = hit_char.saturating_sub(SEARCH_SNIPPET_CHARS / 4);
    let end = (start + SEARCH_SNIPPET_CHARS).min(chars.len());
    let body: String = chars[start..end].iter().collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    format!("{prefix}{body}{suffix}")
}

/// Full-text-ish search across message bodies. Returns at most one hit per
/// conversation (the most recent matching message), newest conversation first.
/// Matching uses SQL `LIKE` with `%`/`_` escaped so the query matches literally.
///
/// Perf (low): the leading-wildcard `LIKE '%…%'` cannot use any B-tree index,
/// so this is O(total message bytes) — an unavoidable full scan of
/// `messages.content` plus the `MAX(id) … GROUP BY conversation_id` aggregate.
/// It is intentionally NOT routed through the faster `search_messages_fts`
/// (messages_fts, v18): FTS5 porter stemming changes substring/sub-token match
/// semantics, so swapping it in would silently regress what the debounced
/// sidebar filter finds. The cost is bounded in practice (single-user desktop
/// DB, 220ms debounce, min 2 chars); revisit only if one user's history grows
/// to tens of thousands of messages.
pub fn search_messages(query: &str) -> Result<Vec<MessageSearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", escape_like(trimmed));
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        // `AND run_id IS NULL` on BOTH the inner MAX(id) subquery and the outer
        // query excludes v28 agent checkpoint shadow rows (mirrors
        // list_messages). The inner filter is load-bearing: checkpoint rows have
        // the highest ids during a run, so without it MAX(id) would surface the
        // hidden in-flight agent content per conversation. The outer filter is
        // defense-in-depth.
        "SELECT m.conversation_id, c.title, m.content
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.run_id IS NULL
           AND m.id IN (
            SELECT MAX(id) FROM messages
            WHERE content LIKE ?1 ESCAPE '\\'
              AND run_id IS NULL
            GROUP BY conversation_id
         )
         ORDER BY m.conversation_id DESC",
    )?;
    let rows = stmt
        .query_map(params![pattern], |r| {
            let conversation_id: i64 = r.get(0)?;
            let title: String = r.get(1)?;
            let content: String = r.get(2)?;
            Ok((conversation_id, title, content))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(conversation_id, title, content)| MessageSearchHit {
            conversation_id,
            title,
            snippet: make_snippet(&content, trimmed),
        })
        .collect())
}

/// Persist per-conversation model params. `params` must be either `None`
/// (clears the column) or a string containing a parseable JSON object —
/// malformed JSON is rejected so the column never holds garbage.
pub fn update_conversation_params(id: i64, params: Option<&str>) -> Result<()> {
    if let Some(raw) = params {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| anyhow::anyhow!("params is not valid JSON: {e}"))?;
        if !value.is_object() {
            return Err(anyhow::anyhow!("params must be a JSON object"));
        }
    }
    // WS3: single-writer gate.
    with_write(|tx| {
        tx.execute(
            "UPDATE conversations SET params = ?1 WHERE id = ?2",
            params![params, id],
        )?;
        Ok(())
    })
}

/// Placeholder title assigned to freshly created conversations. The frontend
/// "+ New chat" path inserts a conversation with exactly this title; auto-
/// titling only fires while the title is still empty or this placeholder.
pub const DEFAULT_CONVERSATION_TITLE: &str = "New chat";

/// Soft target length for an auto-derived conversation title.
const AUTOTITLE_MAX_CHARS: usize = 48;

/// Derive a short, single-line conversation title from a message body.
///
/// Whitespace (including newlines) is collapsed to single spaces and the
/// result trimmed. If the trimmed text fits within `AUTOTITLE_MAX_CHARS` it is
/// returned verbatim; otherwise it is truncated on a word boundary where one
/// exists in the kept window and an ellipsis ('…') is appended. Empty or
/// whitespace-only input yields `None` — callers keep the existing title.
pub fn derive_title(content: &str) -> Option<String> {
    let collapsed: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    // Operate on chars to stay UTF-8 safe under multibyte input.
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= AUTOTITLE_MAX_CHARS {
        return Some(collapsed);
    }
    let window: String = chars[..AUTOTITLE_MAX_CHARS].iter().collect();
    // Prefer cutting at the last space so we don't end on a partial word.
    let trimmed = match window.rfind(' ') {
        Some(idx) if idx > 0 => &window[..idx],
        _ => window.trim_end(),
    };
    Some(format!("{}…", trimmed.trim_end()))
}

/// Whether `title` is still the create-time placeholder (or empty), meaning the
/// conversation has never been explicitly named and is eligible for auto-titling.
fn title_is_placeholder(title: &str) -> bool {
    let t = title.trim();
    t.is_empty() || t == DEFAULT_CONVERSATION_TITLE
}

// NOTE on transaction behavior (2026-06-11, user-hit bug): every write tx in
// this crate uses IMMEDIATE. The default DEFERRED tx begins as a READER and
// only takes the write lock at the first write statement — under WAL, if any
// other pooled connection wrote in between, that promotion fails INSTANTLY
// with SQLITE_BUSY_SNAPSHOT (error 517, "cannot promote read transaction"),
// and busy_timeout does not apply to it. The perf ledger added a concurrent
// writer on the send path and add_message started losing replies. IMMEDIATE
// takes the write lock at BEGIN, where busy_timeout (5000ms) queues us
// properly behind the other writer.
pub fn add_message(
    conv_id: i64,
    role: &str,
    content: &str,
    model: Option<&str>,
    images_json: Option<&str>,
) -> Result<i64> {
    // WS3: route through the single-writer gate. The auto-title read+update runs
    // on the same serialized IMMEDIATE transaction.
    with_write(|tx| add_message_in(tx, conv_id, role, content, model, images_json))
}

/// Connection-scoped `add_message` body. Pulled out so the `#[cfg(test)]`
/// in-memory paths can drive it on their own transaction, bypassing the global
/// write lock.
pub(crate) fn add_message_in(
    tx: &rusqlite::Transaction<'_>,
    conv_id: i64,
    role: &str,
    content: &str,
    model: Option<&str>,
    images_json: Option<&str>,
) -> Result<i64> {
    tx.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![conv_id, role, content, now_unix(), model, images_json],
    )?;
    let message_id = tx.last_insert_rowid();

    // Auto-title: only on the first user message of a still-unnamed conversation.
    if role == "user" {
        if let Some(new_title) = derive_title(content) {
            let current_title: Option<String> = tx
                .query_row(
                    "SELECT title FROM conversations WHERE id = ?1",
                    params![conv_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(current_title) = current_title {
                if title_is_placeholder(&current_title) {
                    // Perf (low): an existence probe that stops at the first
                    // prior user row, rather than COUNT(*)-ing them all just
                    // for a `== 0` check. Auto-title only fires when there is
                    // no earlier user message in this conversation.
                    let has_prior_user_msg: Option<i64> = tx
                        .query_row(
                            "SELECT 1 FROM messages
                             WHERE conversation_id = ?1 AND role = 'user' AND id <> ?2
                             LIMIT 1",
                            params![conv_id, message_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if has_prior_user_msg.is_none() {
                        tx.execute(
                            "UPDATE conversations SET title = ?1 WHERE id = ?2",
                            params![new_title, conv_id],
                        )?;
                    }
                }
            }
        }
    }

    Ok(message_id)
}

/// One turn handed to [`checkpoint_run`] (item 4A). Mirrors the TS
/// `CheckpointTurn` shape the runner emits per iteration. `turn_index` is the
/// monotonically-increasing position within the run; the optional `tool_*`
/// fields are populated for tool-result / assistant-with-tool-call turns.
#[derive(serde::Deserialize, Clone)]
pub struct CheckpointTurn {
    pub turn_index: i64,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Maximum turns accepted in a single checkpoint call. A pathological run can't
/// be allowed to write an unbounded batch in one transaction.
const MAX_CHECKPOINT_TURNS: usize = 4000;

/// Durably checkpoint an in-flight agent run's turns (item 4A). All rows are
/// written under ONE `with_write` IMMEDIATE transaction so a single iteration's
/// state lands atomically. Idempotent on `(conversation_id, run_id, turn_index)`
/// (the v29 UNIQUE index): each turn is upserted, so re-running a checkpoint (or
/// extending it with later turns) never duplicates a row, and unchanged turns
/// are no-op updates — the write cost is O(new + changed turns), not the whole
/// cumulative set the runner re-supplies each iteration. Checkpoint rows carry a
/// non-null `run_id` and are therefore excluded from `list_messages` and message
/// search (the normal conversation view is unchanged; recovery/auto-resume that
/// reads these rows is deferred).
///
/// Returns the number of turn rows written.
pub fn checkpoint_run(run_id: &str, conv_id: i64, turns: &[CheckpointTurn]) -> Result<usize> {
    if run_id.trim().is_empty() {
        anyhow::bail!("run_id must not be empty");
    }
    if turns.len() > MAX_CHECKPOINT_TURNS {
        anyhow::bail!(
            "checkpoint exceeds {MAX_CHECKPOINT_TURNS} turns ({} given)",
            turns.len()
        );
    }
    with_write(|tx| {
        // Incremental checkpoint (perf): the runner passes the CUMULATIVE turn
        // list each iteration, so the old delete-all-then-reinsert wrote
        // 1+2+…+K = O(K²) rows over a K-iteration run and tore down/rebuilt the
        // FTS index every time. Instead upsert on the v29 UNIQUE
        // (conversation_id, run_id, turn_index) index: settled turns are
        // re-supplied unchanged and the `WHERE` guard turns their UPDATE into a
        // no-op, so a checkpoint costs O(new + changed turns). (Checkpoint rows
        // carry a non-null run_id, so the v28 messages_fts_ai trigger guard keeps
        // them out of the FTS index entirely.)
        //
        // `created_at` is set only on first insert (DO UPDATE leaves it) so a
        // turn keeps its original settle time across later checkpoints.
        let now = now_unix();
        for t in turns {
            // `run_done = 0` is set ONLY on first insert — the DO UPDATE branch
            // deliberately leaves it untouched (like `created_at`) so a run that
            // `close_run` already flipped to 1 can never be silently re-opened by
            // a late, racing checkpoint write. A live run only ever appends/edits
            // turns, so its rows stay at 0 until it finishes or the user dismisses.
            tx.execute(
                "INSERT INTO messages
                    (conversation_id, role, content, created_at, model,
                     run_id, turn_index, tool_call_id, tool_name, run_done)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
                 ON CONFLICT(conversation_id, run_id, turn_index) DO UPDATE SET
                    role = excluded.role,
                    content = excluded.content,
                    model = excluded.model,
                    tool_call_id = excluded.tool_call_id,
                    tool_name = excluded.tool_name
                 WHERE role IS NOT excluded.role
                    OR content IS NOT excluded.content
                    OR model IS NOT excluded.model
                    OR tool_call_id IS NOT excluded.tool_call_id
                    OR tool_name IS NOT excluded.tool_name",
                params![
                    conv_id,
                    t.role,
                    t.content,
                    now,
                    t.model,
                    run_id,
                    t.turn_index,
                    t.tool_call_id,
                    t.tool_name,
                ],
            )?;
        }
        // Rare shrink case: a later checkpoint with fewer turns must not leave
        // stale rows behind (the old delete-all path implicitly handled this).
        // turn_index is the contiguous 0-based position within a run (see
        // CheckpointTurn), so any row at turn_index >= the new count is orphaned.
        // Bounded delete of just those few rows — not the whole run.
        tx.execute(
            "DELETE FROM messages
             WHERE conversation_id = ?1 AND run_id = ?2 AND turn_index >= ?3",
            params![conv_id, run_id, turns.len() as i64],
        )?;
        Ok(turns.len())
    })
}

/// One rehydrated turn from an unfinished run's durable checkpoint, returned by
/// [`latest_unfinished_run`]. Mirrors a `CheckpointTurn` plus the row id +
/// settle time, so the frontend can both preview the run ("what was already
/// done") and reconstruct the message history to resume from. `content` is the
/// lossless shadow the runner wrote: for an assistant turn that carried
/// tool_calls it is a JSON `{ content, tool_calls }` envelope (see
/// `checkpointTurnsFrom` in runner.ts); the frontend parses it back.
#[derive(Serialize, Clone)]
pub struct RunCheckpointTurn {
    pub turn_index: i64,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// The most-recent UNFINISHED agent run for a conversation, returned by
/// [`latest_unfinished_run`]. "Unfinished" = the run has checkpoint shadow rows
/// and none of them are marked `run_done = 1`. The frontend uses this to offer a
/// REVIEW-BEFORE-CONTINUE "Resume run" affordance — it NEVER auto-resumes.
#[derive(Serialize, Clone)]
pub struct RunCheckpoint {
    /// The interrupted run's id (`run:<uuid>`).
    pub run_id: String,
    /// Settle time of the run's first checkpoint row (UNIX seconds).
    pub started_at: i64,
    /// Settle time of the run's most-recent checkpoint row (UNIX seconds).
    pub updated_at: i64,
    /// All recoverable agent turns, ordered by `turn_index`.
    pub turns: Vec<RunCheckpointTurn>,
}

/// Read the most-recent UNFINISHED run checkpoint for a conversation, or `None`
/// when there is no resumable run. A run is resumable iff it has at least one
/// checkpoint shadow row (`run_id IS NOT NULL`) AND no row of that run is marked
/// finished (`run_done = 1`). Rows whose `run_done` is NULL (written before v30,
/// or pre-existing) count as open, so an upgrade leaves prior interrupted runs
/// resumable.
///
/// "Most recent" is the run whose newest shadow row has the highest `id`
/// (autoincrement, monotonic per insert). Only that one run's turns are
/// returned — a conversation realistically has at most one interrupted run, and
/// we never offer to resume an older one over a newer.
///
/// This is a READ — no resume side effect happens here. Resuming itself is an
/// explicit, user-driven frontend action.
pub fn latest_unfinished_run(conv_id: i64) -> Result<Option<RunCheckpoint>> {
    let conn = get_db()?;
    // Find the candidate run: the one with the newest shadow row among runs that
    // have NO finished row. `MAX(run_done) IS NOT 1` keeps a run only while none
    // of its rows are closed; SQLite's `IS NOT` treats NULL run_done as open.
    let run_id: Option<String> = conn
        .query_row(
            "SELECT run_id FROM messages
             WHERE conversation_id = ?1 AND run_id IS NOT NULL
             GROUP BY run_id
             HAVING MAX(run_done) IS NOT 1
             ORDER BY MAX(id) DESC
             LIMIT 1",
            params![conv_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(run_id) = run_id else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT turn_index, role, content, created_at, tool_call_id, tool_name, model
         FROM messages
         WHERE conversation_id = ?1 AND run_id = ?2
         ORDER BY turn_index ASC",
    )?;
    let turns = stmt
        .query_map(params![conv_id, run_id], |r| {
            Ok(RunCheckpointTurn {
                turn_index: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
                tool_call_id: r.get(4)?,
                tool_name: r.get(5)?,
                model: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if turns.is_empty() {
        // Defensive: the GROUP BY found a run id but the per-run read returned
        // nothing (a concurrent close/cleanup raced between the two queries).
        // Treat as "no resumable run" rather than returning an empty shell.
        return Ok(None);
    }
    let started_at = turns.first().map(|t| t.created_at).unwrap_or(0);
    let updated_at = turns.iter().map(|t| t.created_at).max().unwrap_or(started_at);
    Ok(Some(RunCheckpoint {
        run_id,
        started_at,
        updated_at,
        turns,
    }))
}

/// Mark a run's checkpoint set FINISHED so it is never re-offered for resume.
/// Called when a run completes, when the user dismisses the resume affordance,
/// or after a successful resume. Flips `run_done = 1` on every shadow row of the
/// `(conversation_id, run_id)` set — a bounded, run-scoped UPDATE (no full scan;
/// served by `idx_messages_conv_run_turn`). Idempotent: re-closing an already-
/// closed (or absent) run is a benign no-op.
///
/// We KEEP the shadow rows (just flip the flag) rather than deleting them so the
/// durable record survives for forensics; the periodic `cleanup_finished_runs`
/// trim bounds their on-disk footprint. Returns the number of rows flipped.
pub fn close_run(run_id: &str, conv_id: i64) -> Result<usize> {
    if run_id.trim().is_empty() {
        anyhow::bail!("run_id must not be empty");
    }
    with_write(|tx| {
        let n = tx.execute(
            "UPDATE messages SET run_done = 1
             WHERE conversation_id = ?1 AND run_id = ?2 AND run_id IS NOT NULL
               AND (run_done IS NULL OR run_done = 0)",
            params![conv_id, run_id],
        )?;
        Ok(n)
    })
}

/// How many finished checkpoint sets to keep before trimming, globally. A
/// closed set is dead weight (only kept for forensics), so we bound the count so
/// a heavy agent user's `messages` table can't accumulate them without limit.
const FINISHED_RUNS_KEEP: i64 = 200;

/// Bounded cleanup of FINISHED checkpoint shadow rows. Deletes the rows of the
/// OLDEST finished runs beyond the most-recent `FINISHED_RUNS_KEEP`, run-by-run,
/// so the delete is bounded and never touches an open (resumable) run or any
/// visible message (`run_id IS NULL`). Best-effort + idempotent; safe to call on
/// every app boot. Returns the number of rows deleted.
///
/// Forward-only: only rows explicitly marked `run_done = 1` are eligible — an
/// in-flight or NULL-flagged (pre-v30) run is never deleted.
pub fn cleanup_finished_runs() -> Result<usize> {
    with_write(|tx| {
        // Distinct finished runs, newest first by their last row id; everything
        // past the keep-window is eligible for deletion.
        let stale: Vec<(i64, String)> = {
            let mut stmt = tx.prepare(
                "SELECT conversation_id, run_id FROM messages
                 WHERE run_id IS NOT NULL AND run_done = 1
                 GROUP BY conversation_id, run_id
                 ORDER BY MAX(id) DESC
                 LIMIT -1 OFFSET ?1",
            )?;
            let rows = stmt
                .query_map(params![FINISHED_RUNS_KEEP], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut deleted = 0usize;
        for (conv_id, run_id) in stale {
            deleted += tx.execute(
                "DELETE FROM messages
                 WHERE conversation_id = ?1 AND run_id = ?2 AND run_done = 1",
                params![conv_id, run_id],
            )?;
        }
        Ok(deleted)
    })
}

/// Hard ceiling on how many messages one `list_messages` call returns. A
/// pathologically long single conversation would otherwise serialize every
/// message into one IPC payload. We keep the MOST RECENT `MESSAGES_LIST_MAX`
/// (inner ORDER BY id DESC + LIMIT, then re-sort ASC for display) — the tail
/// is what a user actually reads in a huge thread. 10k is far above any normal
/// conversation, so the common case is unaffected.
const MESSAGES_LIST_MAX: i64 = 10_000;

pub fn list_messages(conv_id: i64) -> Result<Vec<Message>> {
    let conn = get_db()?;
    // Item 4A: agent per-iteration checkpoint rows carry a non-null `run_id`
    // (they're a durable shadow of in-flight agent state for a FUTURE recovery
    // feature, which is deferred). They must NOT surface in the normal
    // conversation view — today only the user turn and the final assistant turn
    // are displayed/persisted-as-visible, and that stays byte-identical. The
    // `run_id IS NULL` filter excludes the shadow rows. (Pre-v28 DBs have no
    // run_id column, but setup_schema runs the v28 migration on every boot
    // before any read, so the column is always present here.)
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, created_at, model, images FROM (
            SELECT id, conversation_id, role, content, created_at, model, images
            FROM messages WHERE conversation_id = ?1 AND run_id IS NULL
            ORDER BY id DESC LIMIT ?2
         ) ORDER BY id ASC",
    )?;
    let rows = stmt
        .query_map(params![conv_id, MESSAGES_LIST_MAX], |r| {
            Ok(Message {
                id: Some(r.get(0)?),
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                created_at: Some(r.get(4)?),
                model: r.get(5)?,
                images: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Maximum fork-tree recursion depth. Bounds the response so a pathological
/// chain of forks can't blow the stack or balloon the JSON payload.
const FORK_TREE_MAX_DEPTH: usize = 10;

/// Deep-copy a conversation up to (and including) `at_message_id`.
///
/// 1. Inserts a new `conversations` row with `parent_conv_id = source_id` and
///    `parent_message_id = at_message_id`. Title is the source title + " (fork)".
/// 2. Copies every message from the source with `id <= at_message_id` into the
///    new conversation, **assigning fresh ids** — modifying the fork after
///    creation will never touch the parent's rows.
///
/// All writes run inside a single transaction; if any step fails the whole
/// thing rolls back and no partial fork remains in the DB.
pub fn fork_conversation(source_id: i64, at_message_id: i64) -> Result<i64> {
    // WS3: single-writer gate. All fork writes run on its serialized txn.
    with_write(|tx| fork_conversation_tx(tx, source_id, at_message_id))
}

/// Connection-scoped fork implementation. Opens its own IMMEDIATE transaction
/// and delegates to `fork_conversation_tx`. Kept so the `#[cfg(test)]`
/// in-memory paths can drive a fork on a private `&mut Connection` without
/// standing up the global pool (and thus bypassing the WS3 write lock).
#[cfg(test)]
pub(crate) fn fork_conversation_in(
    conn: &mut Connection,
    source_id: i64,
    at_message_id: i64,
) -> Result<i64> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let new_id = fork_conversation_tx(&tx, source_id, at_message_id)?;
    tx.commit()?;
    Ok(new_id)
}

/// Transaction-scoped fork body — no commit (the caller owns the transaction).
/// Shared by the live `with_write` path and the test `&mut Connection` path.
fn fork_conversation_tx(
    tx: &rusqlite::Transaction<'_>,
    source_id: i64,
    at_message_id: i64,
) -> Result<i64> {
    // Look up the source row. Bail loudly if it doesn't exist — silently
    // creating an orphan fork would just hide caller bugs.
    // P2 #52: fork now also copies tags, pinned, and params so a forked
    // conversation isn't a stripped-down clone — the user expects "give
    // me a branch from here, same project context" not "give me a blank
    // chat with the same model". Each column is nullable on older DBs,
    // so the query tolerates missing-column shape via COALESCE-style
    // optional get; a fresh DB has all four.
    let (title, model, tags, pinned, params_json): (
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = tx
        .query_row(
            "SELECT title, model, tags, pinned, params FROM conversations WHERE id = ?1",
            params![source_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .context("source conversation not found")?;

    let fork_title = format!("{title} (fork)");
    tx.execute(
        "INSERT INTO conversations
            (title, model, created_at, parent_conv_id, parent_message_id,
             tags, pinned, params)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            fork_title,
            model,
            now_unix(),
            source_id,
            at_message_id,
            tags,
            pinned.unwrap_or(0),
            params_json,
        ],
    )?;
    let new_id = tx.last_insert_rowid();

    // Copy messages with id <= cutoff. `INSERT … SELECT` keeps the per-row
    // work in SQLite and assigns new autoincrement ids automatically. The
    // `run_id IS NULL` guard excludes v28 agent checkpoint shadow rows (a
    // durable shadow of in-flight agent state hidden from the conversation
    // view) — mirrors `list_messages` + the maintenance archive DELETE so a
    // fork is a copy of the VISIBLE turns, never the transient shadows. (Pre-
    // v28 DBs lack run_id, but setup_schema runs the v28 rung before any read,
    // so the column is always present here.)
    tx.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
         SELECT ?1, role, content, created_at, model, images
         FROM messages
         WHERE conversation_id = ?2 AND id <= ?3 AND run_id IS NULL
         ORDER BY id ASC",
        params![new_id, source_id, at_message_id],
    )?;

    Ok(new_id)
}

/// Direct children of `conv_id` — does not recurse. Use `get_fork_tree` for
/// the full descendant tree.
pub fn list_branches(conv_id: i64) -> Result<Vec<BranchInfo>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, parent_message_id
         FROM conversations
         WHERE parent_conv_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![conv_id], |r| {
            Ok(BranchInfo {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                parent_message_id: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Recursive walk producing a tree of conversation nodes rooted at
/// `root_conv_id`. Depth-capped at `FORK_TREE_MAX_DEPTH` — descendants past
/// the cap are silently dropped (their parent node is still returned with
/// `children = []`).
pub fn get_fork_tree(root_conv_id: i64) -> Result<ForkTree> {
    let conn = get_db()?;
    fork_tree_node(&conn, root_conv_id, 0)
}

fn fork_tree_node(conn: &Connection, id: i64, depth: usize) -> Result<ForkTree> {
    let (title, created_at, parent_conv_id, parent_message_id): (
        String,
        i64,
        Option<i64>,
        Option<i64>,
    ) = conn
        .query_row(
            "SELECT title, created_at, parent_conv_id, parent_message_id
             FROM conversations WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .context("conversation not found")?;

    let children = if depth >= FORK_TREE_MAX_DEPTH {
        // Cap reached — return the node but stop recursing. Truncation is
        // silent; the frontend can show an ellipsis if it tracks depth.
        Vec::new()
    } else {
        let mut stmt = conn.prepare(
            "SELECT id FROM conversations WHERE parent_conv_id = ?1 ORDER BY created_at ASC",
        )?;
        let child_ids: Vec<i64> = stmt
            .query_map(params![id], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut nodes = Vec::with_capacity(child_ids.len());
        for cid in child_ids {
            nodes.push(fork_tree_node(conn, cid, depth + 1)?);
        }
        nodes
    };

    Ok(ForkTree {
        id,
        title,
        created_at,
        parent_conv_id,
        parent_message_id,
        children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Smoke test: the sqlite-vec auto-extension links + registers, so
    /// `vec_version()` returns and a vec0 virtual table accepts a row. Proves
    /// the FFI symbol is reachable under `bundled` rusqlite (no
    /// `loadable_extension` feature / no shipped dylib).
    #[test]
    fn vec0_extension_links_and_registers() {
        let conn = test_open_in_memory_with_vec();
        let ver: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .expect("vec_version() must resolve once auto-extension is registered");
        assert!(!ver.is_empty(), "vec_version returned empty");
        assert!(vec0_available(), "VEC0_AVAILABLE must be set after probe");

        ensure_vec_table(&conn, VEC_RAG_CHUNKS, 4).unwrap();
        assert!(table_exists(&conn, VEC_RAG_CHUNKS).unwrap());
        assert_eq!(vec_table_dim(&conn, VEC_RAG_CHUNKS), Some(4));

        // vec0 accepts a raw little-endian f32 BLOB directly.
        let v = vec![0.5f32, 0.5, 0.5, 0.5];
        conn.execute(
            &format!("INSERT INTO {VEC_RAG_CHUNKS}(chunk_id, embedding) VALUES (1, ?1)"),
            params![crate::util::vec_to_blob(&v)],
        )
        .unwrap();
        let n: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {VEC_RAG_CHUNKS}"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    /// v18 FTS5: triggers keep the index live, BM25 search returns the
    /// MESSAGE with a snippet, and the per-token quoting neutralizes FTS
    /// operator injection ("NEAR(", unbalanced quotes, column filters).
    #[test]
    fn fts_message_search_round_trip() {
        let tag = format!("zfts{}", std::process::id());
        let conv = create_conversation(&format!("__test_fts_{tag}"), None).unwrap();
        let msg = add_message(
            conv,
            "assistant",
            &format!("we fixed the {tag} watermark swap during ingest"),
            None,
            None,
        )
        .unwrap();

        let hits = search_messages_fts(&format!("{tag} watermark"), 10).unwrap();
        assert!(
            hits.iter()
                .any(|h| h.message_id == msg && h.conversation_id == conv),
            "expected the inserted message in hits: {hits:?}"
        );
        let hit = hits.iter().find(|h| h.message_id == msg).unwrap();
        assert!(
            hit.snippet.contains('['),
            "snippet should mark matches: {}",
            hit.snippet
        );

        // Operator-shaped queries must not error (quoted as plain phrases).
        for hostile in ["NEAR(", "a AND b OR", "col:x", "\"unbalanced", "*"] {
            let _ = search_messages_fts(hostile, 5).expect("hostile query must not error");
        }

        // Delete trigger drops the index rows with the conversation cascade.
        delete_conversation(conv).unwrap();
        let after = search_messages_fts(&format!("{tag} watermark"), 10).unwrap();
        assert!(
            !after.iter().any(|h| h.message_id == msg),
            "deleted message must leave the index"
        );
    }

    /// WS3 single-writer gate: many threads writing concurrently through
    /// `with_write` (via `add_message`) all land — none are lost to
    /// write-promotion failures (the SQLITE_BUSY_SNAPSHOT class the gate
    /// prevents). Exercises the real pool + lock end-to-end.
    #[test]
    fn with_write_serializes_concurrent_writers_no_loss() {
        let conv = create_conversation(
            &format!("__test_ws3_{}", std::process::id()),
            None,
        )
        .unwrap();
        const THREADS: usize = 8;
        const PER_THREAD: usize = 20;
        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        add_message(
                            conv,
                            "assistant",
                            &format!("t{t}-msg{i}"),
                            None,
                            None,
                        )
                        .expect("concurrent add_message must not fail");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let n: i64 = {
            let conn = get_db().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
                params![conv],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            n as usize,
            THREADS * PER_THREAD,
            "every concurrent write must be persisted"
        );
        delete_conversation(conv).unwrap();
    }

    /// Build a fresh in-memory DB pre-populated with the *pre-images* schema
    /// shape, then run the migration twice. Tests both correctness (column
    /// appears) and idempotence (re-running does not error out on the
    /// "duplicate column name" SQLite raises).
    #[test]
    fn images_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                model TEXT
            );",
        )
        .unwrap();

        ensure_messages_images_column(&conn).expect("first migration");
        ensure_messages_images_column(&conn).expect("second migration must not error");
        ensure_messages_images_column(&conn).expect("third migration must not error");

        // The column must now be present.
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'images'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has, "images column should exist after migration");
    }

    /// Build an in-memory DB with the post-fork-migration schema and seed a
    /// conversation with `n` messages. Returns (conn, conversation_id).
    fn fresh_db_with_conv(n: usize) -> (Connection, i64) {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                model TEXT,
                images TEXT,
                -- v28 checkpoint columns: the fork copy now filters on `run_id
                -- IS NULL`, so this minimal hand-rolled schema needs the column.
                run_id TEXT
            );",
        )
        .unwrap();
        // Run the migration twice to confirm idempotence under realistic boot.
        ensure_conversation_fork_columns(&conn).expect("fork migration 1");
        ensure_conversation_fork_columns(&conn).expect("fork migration 2 must not error");
        ensure_conversation_params_column(&conn).expect("params migration 1");
        ensure_conversation_params_column(&conn).expect("params migration 2 must not error");
        ensure_conversation_org_columns(&conn).expect("org migration 1");
        ensure_conversation_org_columns(&conn).expect("org migration 2 must not error");

        conn.execute(
            "INSERT INTO conversations (title, model, created_at) VALUES (?1, ?2, ?3)",
            params!["seed", Some("test-model"), 1000_i64],
        )
        .unwrap();
        let conv_id = conn.last_insert_rowid();
        for i in 0..n {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conv_id,
                    role,
                    format!("msg-{i}"),
                    1000_i64 + i as i64,
                    "m",
                    Option::<String>::None
                ],
            )
            .unwrap();
        }
        // Sanity check that we actually have the parent columns.
        let _: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'parent_conv_id'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        (conn, conv_id)
    }

    fn message_count(conn: &Connection, conv_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
            params![conv_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    }

    #[test]
    fn fork_copies_messages_up_to_cutoff() {
        let (mut conn, src) = fresh_db_with_conv(5);
        // Cutoff at the 3rd message (id = 3 since autoincrement starts at 1
        // and we seeded a single conversation).
        let cutoff = 3;
        let fork_id = fork_conversation_in(&mut conn, src, cutoff).expect("fork");
        assert_ne!(fork_id, src, "fork must have a distinct id");

        // Exactly the first `cutoff` messages should be present.
        assert_eq!(message_count(&conn, fork_id), cutoff);
        assert_eq!(
            message_count(&conn, src),
            5,
            "parent untouched at fork time"
        );

        // Parent link is recorded on the fork row.
        let (parent, parent_msg, title): (Option<i64>, Option<i64>, String) = conn
            .query_row(
                "SELECT parent_conv_id, parent_message_id, title FROM conversations WHERE id = ?1",
                params![fork_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, Some(src));
        assert_eq!(parent_msg, Some(cutoff));
        assert!(title.ends_with(" (fork)"));

        // Messages on the fork must have *new* ids, not the originals — proving
        // we did a deep copy rather than re-pointing.
        let original_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| r.get::<_, i64>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let fork_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![fork_id], |r| r.get::<_, i64>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for fid in &fork_ids {
            assert!(
                !original_ids.contains(fid),
                "fork message id {fid} collided with parent — copy was shallow"
            );
        }
    }

    #[test]
    fn parent_unchanged_after_fork_is_mutated() {
        let (mut conn, src) = fresh_db_with_conv(4);
        let fork_id = fork_conversation_in(&mut conn, src, 2).expect("fork");

        // Snapshot parent before mutating the fork.
        let parent_before: Vec<(i64, String)> = {
            let mut s = conn
                .prepare("SELECT id, content FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };

        // Mutate the fork: append a new message AND rewrite an existing one.
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
             VALUES (?1, 'user', 'fork-only', 9999, 'm', NULL)",
            params![fork_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE messages SET content = 'rewritten in fork'
             WHERE conversation_id = ?1 AND role = 'user'",
            params![fork_id],
        )
        .unwrap();
        // Also delete a fork message — must not cascade to parent.
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND content = 'fork-only'",
            params![fork_id],
        )
        .unwrap();

        let parent_after: Vec<(i64, String)> = {
            let mut s = conn
                .prepare("SELECT id, content FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };

        assert_eq!(
            parent_before, parent_after,
            "parent rows must be identical after fork mutation"
        );
        assert_eq!(message_count(&conn, src), 4, "parent count untouched");
    }

    /// REGRESSION: forking a conversation that has v28 agent checkpoint shadow
    /// rows (`run_id IS NOT NULL`) must NOT copy those rows into the fork — the
    /// fork is a branch of the VISIBLE conversation, not of transient in-flight
    /// agent state. Before the `AND run_id IS NULL` guard on the fork's
    /// `INSERT … SELECT`, the shadows leaked into the fork and `list_messages`
    /// on the fork still hid them only because of its own filter — but the rows
    /// (and the tool-result text the user never saw) were physically duplicated.
    /// Driven through the global DB so the real `list_messages` reader applies.
    #[test]
    fn fork_excludes_checkpoint_shadow_rows() {
        let conv =
            create_conversation(&format!("__test_fork_ckpt_{}", std::process::id()), None).unwrap();
        // Two visible turns (run_id NULL via the normal add_message path).
        add_message(conv, "user", "build me a thing", None, None).unwrap();
        let last_visible = add_message(conv, "assistant", "done", None, None).unwrap();

        // Checkpoint shadow rows for an in-flight run — these get HIGHER ids than
        // the visible turns, so a fork cutoff above them would copy them if the
        // run_id filter were absent.
        let run = format!("run:forkckpt:{}", std::process::id());
        let turns = vec![
            CheckpointTurn {
                turn_index: 0,
                role: "assistant".into(),
                content: "{\"content\":\"thinking\",\"tool_calls\":[]}".into(),
                tool_call_id: None,
                tool_name: None,
                model: Some("m".into()),
            },
            CheckpointTurn {
                turn_index: 1,
                role: "tool".into(),
                content: "secret tool output the user never saw".into(),
                tool_call_id: Some("call_1".into()),
                tool_name: Some("read_file".into()),
                model: None,
            },
        ];
        checkpoint_run(&run, conv, &turns).unwrap();

        // Highest message id in the conversation — above every shadow row, so the
        // id-cutoff alone would NOT exclude them. Only the run_id filter does.
        let max_id: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT MAX(id) FROM messages WHERE conversation_id = ?1",
                params![conv],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            max_id > last_visible,
            "shadow rows must have higher ids than the last visible turn"
        );

        let fork_id = fork_conversation(conv, max_id).unwrap();

        // The fork's VISIBLE conversation is exactly the two visible turns.
        let visible = list_messages(fork_id).unwrap();
        assert_eq!(visible.len(), 2, "fork must hold only the visible turns");
        assert_eq!(visible[0].role, "user");
        assert_eq!(visible[1].role, "assistant");

        // And the shadow rows were never physically copied: the raw fork message
        // count equals the visible count (no run_id IS NOT NULL rows on the fork).
        let raw_fork: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
                params![fork_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw_fork, 2, "no shadow rows physically copied into the fork");
        let shadow_on_fork: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM messages \
                 WHERE conversation_id = ?1 AND run_id IS NOT NULL",
                params![fork_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shadow_on_fork, 0, "fork must carry zero checkpoint shadow rows");

        delete_conversation(conv).unwrap();
        delete_conversation(fork_id).unwrap();
    }

    #[test]
    fn derive_title_collapses_whitespace() {
        let got = derive_title("  hello\n\tthere   world  ").unwrap();
        assert_eq!(got, "hello there world");
    }

    #[test]
    fn derive_title_returns_none_for_empty_or_whitespace() {
        assert!(derive_title("").is_none());
        assert!(derive_title("   \n\t  ").is_none());
    }

    #[test]
    fn derive_title_keeps_short_input_verbatim() {
        let short = "How do I parse JSON in Rust?";
        assert_eq!(derive_title(short).unwrap(), short);
    }

    #[test]
    fn derive_title_truncates_on_word_boundary_with_ellipsis() {
        let long = "Please explain how the Rust borrow checker handles \
                    nested closures and lifetimes";
        let got = derive_title(long).unwrap();
        assert!(got.ends_with('…'), "expected ellipsis, got {got:?}");
        // No trailing partial word: the char before the ellipsis is not mid-word
        // truncation — the kept text matches the start of the collapsed input.
        let body = got.trim_end_matches('…');
        assert!(long.starts_with(body), "kept text must be a prefix");
        assert!(!body.ends_with(' '), "no trailing space before ellipsis");
        // Soft cap honoured (body + ellipsis stays bounded).
        assert!(body.chars().count() <= 48);
    }

    #[test]
    fn derive_title_handles_no_space_overlong_input() {
        let long = "a".repeat(120);
        let got = derive_title(&long).unwrap();
        assert!(got.ends_with('…'));
        assert_eq!(got.trim_end_matches('…').chars().count(), 48);
    }

    #[test]
    fn derive_title_is_utf8_safe() {
        // 60 multibyte chars — truncation must not split a char.
        let long = "数".repeat(60);
        let got = derive_title(&long).unwrap();
        assert!(got.ends_with('…'));
    }

    #[test]
    fn params_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_params_column(&conn).expect("first");
        ensure_conversation_params_column(&conn).expect("second");
        ensure_conversation_params_column(&conn).expect("third");
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'params'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);
    }

    /// `update_conversation_params` only accepts `None` or a parseable JSON
    /// object. Everything else (malformed JSON, non-object JSON) is rejected.
    #[test]
    fn params_json_validation() {
        // The validation logic, exercised directly without the global pool.
        fn validate(p: Option<&str>) -> Result<()> {
            if let Some(raw) = p {
                let value: serde_json::Value = serde_json::from_str(raw)
                    .map_err(|e| anyhow::anyhow!("params is not valid JSON: {e}"))?;
                if !value.is_object() {
                    return Err(anyhow::anyhow!("params must be a JSON object"));
                }
            }
            Ok(())
        }

        // Valid: null.
        assert!(validate(None).is_ok());
        // Valid: a well-formed params object.
        assert!(validate(Some(
            r#"{"temperature":0.7,"top_p":null,"max_tokens":2048,"system_prompt":"hi"}"#
        ))
        .is_ok());
        // Valid: empty object.
        assert!(validate(Some("{}")).is_ok());
        // Invalid: malformed JSON.
        assert!(validate(Some("{not json")).is_err());
        assert!(validate(Some(r#"{"temperature": }"#)).is_err());
        // Invalid: valid JSON but not an object.
        assert!(validate(Some("[1,2,3]")).is_err());
        assert!(validate(Some("42")).is_err());
        assert!(validate(Some("\"a string\"")).is_err());
    }

    /// Feed a deliberately-corrupt SQLite file: the integrity probe must flag
    /// it, quarantine must rename it aside (with siblings), and schema setup
    /// must then produce a usable fresh DB at the original path.
    #[test]
    fn corrupt_db_is_quarantined_and_recreated() {
        let dir =
            std::env::temp_dir().join(format!("froglips-db-corrupt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("db.sqlite");

        // Garbage bytes — not a valid SQLite header.
        std::fs::write(&db, b"this is definitely not a sqlite database file").unwrap();

        // Probe flags it as corrupt.
        assert!(!integrity_ok(&db), "garbage file must fail integrity check");

        // Plausible WAL/SHM siblings that must also be moved aside. Written
        // after the probe — SQLite may clean up sidecar files when it closes
        // a connection it opened during the integrity check.
        std::fs::write(dir.join("db.sqlite-wal"), b"junk-wal").unwrap();
        std::fs::write(dir.join("db.sqlite-shm"), b"junk-shm").unwrap();

        // Quarantine renames the file aside.
        quarantine_corrupt_db(&db).expect("quarantine should succeed");
        assert!(!db.exists(), "corrupt file must be moved off the live path");
        let quarantined: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            quarantined.iter().any(|n| n.contains("db.sqlite.corrupt-")),
            "expected a quarantined db file, got {quarantined:?}"
        );
        assert!(
            quarantined.iter().any(|n| n.ends_with("-wal")),
            "wal sibling should be quarantined too"
        );
        assert!(
            quarantined.iter().any(|n| n.ends_with("-shm")),
            "shm sibling should be quarantined too"
        );

        // A fresh DB built at the original path is healthy and usable.
        {
            let conn = Connection::open(&db).expect("open fresh db");
            setup_schema(&conn).expect("schema setup on fresh db");
            let ok: String = conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap();
            assert_eq!(ok, "ok", "fresh db must pass integrity check");
            conn.execute(
                "INSERT INTO conversations (title, model, created_at) VALUES ('t', NULL, 1)",
                [],
            )
            .expect("fresh db must accept writes");
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A healthy DB must pass the integrity probe untouched.
    #[test]
    fn healthy_db_passes_integrity_check() {
        let dir =
            std::env::temp_dir().join(format!("froglips-db-healthy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("db.sqlite");
        {
            let conn = Connection::open(&db).unwrap();
            setup_schema(&conn).unwrap();
        }
        assert!(integrity_ok(&db), "a real db must pass integrity check");
        // A non-existent path is treated as fine — schema setup will create it.
        assert!(integrity_ok(&dir.join("does-not-exist.sqlite")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The full set of columns the migration ladder must produce on each
    /// table — the canonical "today's schema" assertion target.
    fn assert_final_schema(conn: &Connection) {
        let cols = |table: &str| -> Vec<String> {
            let mut s = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap();
            s.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for c in [
            "id",
            "title",
            "model",
            "created_at",
            "parent_conv_id",
            "parent_message_id",
            "params",
            "pinned",
            "tags",
        ] {
            assert!(
                cols("conversations").contains(&c.to_string()),
                "conversations.{c}"
            );
        }
        for c in [
            "id",
            "conversation_id",
            "role",
            "content",
            "created_at",
            "model",
            "images",
            // v28 — agent checkpoint columns.
            "tool_call_id",
            "tool_name",
            "run_id",
            "turn_index",
            // v30 — resume: checkpoint-set finished flag.
            "run_done",
        ] {
            assert!(cols("messages").contains(&c.to_string()), "messages.{c}");
        }
        for c in ["scope", "project_root"] {
            assert!(cols("memories").contains(&c.to_string()), "memories.{c}");
        }
        for c in [
            "id",
            "conv_id",
            "model",
            "prompt",
            "params_json",
            "path",
            "width",
            "height",
            "seed",
            "created_at",
        ] {
            assert!(cols("images").contains(&c.to_string()), "images.{c}");
        }
        // v20 — agent_audit + agent_session_metrics (folded from the
        // post-ladder DDL block).
        for c in [
            "id",
            "ts",
            "conversation_id",
            "conv_id", // v24
            "tool_name",
            "args_json",
            "result_hash",
            "result_size",
            "duration_ms",
            "approval",
            "outcome",
            "error_kind",
            "workflow_run_id",
        ] {
            assert!(
                cols("agent_audit").contains(&c.to_string()),
                "agent_audit.{c}"
            );
        }
        for c in ["id", "ts", "conversation_id", "conv_id", "iterations"] {
            assert!(
                cols("agent_session_metrics").contains(&c.to_string()),
                "agent_session_metrics.{c}"
            );
        }
        // v21 — RAG tables, including the v21-guarded `embedder` column.
        for c in ["id", "name", "root_path", "chunk_count", "embedder"] {
            assert!(
                cols("rag_corpora").contains(&c.to_string()),
                "rag_corpora.{c}"
            );
        }
        assert!(
            !cols("rag_chunks").is_empty(),
            "rag_chunks table must exist"
        );
        assert!(!cols("rag_files").is_empty(), "rag_files table must exist");
        // v22 — model_perf_samples (folded from the post-ladder DDL block).
        for c in [
            "id",
            "ts",
            "model",
            "backend",
            "ttft_ms",
            "tok_per_sec",
            "completion_tokens",
            "cold_load",
        ] {
            assert!(
                cols("model_perf_samples").contains(&c.to_string()),
                "model_perf_samples.{c}"
            );
        }
        // v31 — Skills & Tools hub: claude_skills.category.
        for c in [
            "id",
            "name",
            "description",
            "body_md",
            "enabled",
            "pinned",
            "category",
        ] {
            assert!(
                cols("claude_skills").contains(&c.to_string()),
                "claude_skills.{c}"
            );
        }
        // v29 — UNIQUE checkpoint-upsert index.
        let uniq: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' \
                 AND name='idx_messages_conv_run_turn'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(uniq, 1, "v29 unique checkpoint index present");
    }

    /// v26/v27 vec0 tables only exist once a vector of known dim has been
    /// observed (they're created lazily at the source data's dim). Seed one RAG
    /// chunk + one memory embedding, run the runtime backfill, then assert the
    /// vec tables exist at the seeded dim. Skips gracefully if vec0 isn't linked
    /// (the linear fallback is the contract in that case).
    fn assert_vec_tables_after_seed(conn: &Connection) {
        if !vec0_available() {
            return;
        }
        let dim = 4usize;
        let v = crate::util::vec_to_blob(&vec![0.5f32; dim]);
        // Need a corpus row for the FK; minimal valid row.
        conn.execute(
            "INSERT INTO rag_corpora (name, root_path, chunk_count, created_at, updated_at)
             VALUES ('__vec_seed', '/tmp', 0, 0, 0)",
            [],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
             VALUES (?1, 'p', 0, 1, 't', ?2)",
            params![cid, v],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memories (content, tags, status, created_at, embedding, scope)
             VALUES ('m', '', 'active', 0, ?1, 'global')",
            params![v],
        )
        .unwrap();
        ensure_vec_tables_present(conn).expect("runtime vec backfill");
        assert!(
            table_exists(conn, VEC_RAG_CHUNKS).unwrap(),
            "vec_rag_chunks must exist after seed+backfill"
        );
        assert!(
            table_exists(conn, VEC_MEMORIES).unwrap(),
            "vec_memories must exist after seed+backfill"
        );
        assert_eq!(vec_table_dim(conn, VEC_RAG_CHUNKS), Some(dim));
        assert_eq!(vec_table_dim(conn, VEC_MEMORIES), Some(dim));
        // Backfill carried the seeded rows into the vec index.
        let rag_n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {VEC_RAG_CHUNKS}"), [], |r| {
                r.get(0)
            })
            .unwrap();
        let mem_n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {VEC_MEMORIES}"), [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rag_n, 1, "vec_rag_chunks backfilled");
        assert_eq!(mem_n, 1, "vec_memories backfilled");
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    /// A fresh DB run through the ladder lands on the final user_version with
    /// the complete current schema, and (when vec0 is linked) the vec0 tables
    /// materialize via the runtime backfill once data exists.
    #[test]
    fn migration_ladder_fresh_db_reaches_latest() {
        let conn = test_open_in_memory_with_vec();
        assert_eq!(user_version(&conn), 0, "fresh DB starts at version 0");
        run_migrations(&conn).expect("ladder on fresh db");
        assert_eq!(user_version(&conn), latest_version());
        assert_final_schema(&conn);
        assert_vec_tables_after_seed(&conn);
    }

    /// REGRESSION (v0.14.1 — critical upgrade-brick): a real pre-v0.14.0 DB has
    /// an `agent_audit` table WITHOUT the `conv_id` column at user_version 19.
    /// The folded v20 rung (`agent_audit::ensure_schema`) ran BEFORE v24 added
    /// `conv_id`, yet eagerly created `idx_agent_audit_conv_id ON agent_audit(conv_id)`
    /// → "no such column: conv_id" → the whole migration aborted → every
    /// upgrading user was locked out of their DB. This test ages a full schema
    /// back to the real pre-v0.14.0 shape and re-runs the ladder; it must reach
    /// latest without aborting and preserve the legacy audit row.
    #[test]
    fn migration_ladder_upgrades_pre_v0140_agent_audit_without_conv_id() {
        let conn = test_open_in_memory_with_vec();
        run_migrations(&conn).expect("build full schema");
        // Seed a legacy audit row, then strip conv_id + its index and stamp the
        // DB at v19 — exactly what a 0.13.x install looks like before upgrading.
        conn.execute_batch(
            "INSERT INTO agent_audit
               (ts, conversation_id, tool_name, args_json, result_hash, result_size,
                duration_ms, approval, outcome)
             VALUES (1, '7', 'read_file', '{}', 'h', 0, 1, 'auto', 'ok');
             DROP INDEX IF EXISTS idx_agent_audit_conv_id;
             DROP INDEX IF EXISTS idx_agent_session_metrics_conv_id;
             ALTER TABLE agent_audit DROP COLUMN conv_id;
             ALTER TABLE agent_session_metrics DROP COLUMN conv_id;
             PRAGMA user_version = 19;",
        )
        .expect("age schema back to pre-v0.14.0");
        assert!(!column_exists(&conn, "agent_audit", "conv_id").unwrap());

        // The bug: this aborted with "no such column: conv_id".
        run_migrations(&conn).expect("upgrade from a real pre-v0.14.0 agent_audit must not abort");

        assert_eq!(user_version(&conn), latest_version());
        assert!(column_exists(&conn, "agent_audit", "conv_id").unwrap());
        assert!(column_exists(&conn, "agent_session_metrics", "conv_id").unwrap());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "legacy audit row must survive the upgrade");
        let has_idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' \
                 AND name='idx_agent_audit_conv_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_idx, 1, "conv_id index must be (re)created by the v24 rung");
    }

    /// REGRESSION (v32 — external-content FTS corruption): the v18 messages_fts
    /// DELETE/UPDATE triggers lacked the `run_id IS NULL` guard the INSERT
    /// trigger carries, so deleting a v28 checkpoint shadow row issued an FTS5
    /// 'delete' command for a posting that was never inserted — corrupting the
    /// external-content index. This ages a DB back to the pre-v32 shape (OLD
    /// unguarded triggers, user_version 31, a visible row + a shadow row whose
    /// stale delete-posting got pushed), runs the ladder, and asserts the v32
    /// rung repaired it: the FTS integrity-check passes, the visible row is
    /// searchable, and both triggers now carry the guard.
    #[test]
    fn migration_ladder_v32_repairs_unguarded_fts_triggers() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("build full schema");

        // Age the two triggers back to their v18 (unguarded) form and stamp the
        // DB at v31 — exactly what an install predating the v32 rung looks like.
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS messages_fts_ad;
             DROP TRIGGER IF EXISTS messages_fts_au;
             CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
             END;
             CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
             END;
             PRAGMA user_version = 31;",
        )
        .expect("age triggers back to pre-v32 unguarded form");

        conn.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('t', 0)",
            [],
        )
        .unwrap();
        let cid: i64 = conn.last_insert_rowid();
        // A visible row (run_id NULL — the guarded _ai trigger indexes it) and a
        // checkpoint shadow row (run_id NOT NULL — _ai skips it, so it has NO
        // posting in the external-content index).
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at, run_id)
             VALUES (?1, 'user', 'visible needle row', 0, NULL)",
            params![cid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at, run_id, turn_index)
             VALUES (?1, 'tool', 'shadow tool output', 0, 'run:x', 0)",
            params![cid],
        )
        .unwrap();
        let shadow_id: i64 = conn.last_insert_rowid();
        // Under the OLD unguarded trigger, deleting the shadow row pushes a
        // 'delete' posting for a rowid that was never inserted — the corruption.
        conn.execute("DELETE FROM messages WHERE id = ?1", params![shadow_id])
            .unwrap();

        // Run the ladder: the v32 rung drops+recreates the guarded triggers and
        // runs one `rebuild` to repair the index.
        run_migrations(&conn).expect("upgrade across the v32 rung must not abort");
        assert_eq!(user_version(&conn), latest_version());

        // The FTS index is consistent again: the integrity-check command raises
        // SQLITE_CORRUPT_VTAB if the index disagrees with the content table.
        conn.execute_batch(
            "INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');",
        )
        .expect("messages_fts integrity-check must pass after the v32 rebuild");

        // The visible row is still searchable (rebuild re-derived its posting).
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'needle'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "visible row must remain searchable after repair");

        // Both triggers now carry the run_id-NULL guard.
        for (name, needle) in [
            ("messages_fts_ad", "old.run_id IS NULL"),
            ("messages_fts_au", "new.run_id IS NULL"),
        ] {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
                    params![name],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("{name} trigger must exist"));
            assert!(
                sql.contains(needle),
                "{name} must carry the `{needle}` guard after v32; got: {sql}"
            );
        }

        // Idempotent: re-running the v32 rung body against the now-current DB is
        // safe (DROP IF EXISTS + CREATE IF NOT EXISTS + pure rebuild).
        let v32 = MIGRATIONS
            .iter()
            .find(|m| m.version == 32)
            .expect("v32 rung exists");
        (v32.apply)(&conn).expect("v32 re-run must not error");
        conn.execute_batch(
            "INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');",
        )
        .expect("integrity-check must still pass after a v32 re-run");
    }

    /// Migration v10 (`images`) is safe to apply twice in a row and against a
    /// DB that already has rows in upstream tables — exercises the CREATE
    /// TABLE IF NOT EXISTS + index path without trying to re-create columns.
    #[test]
    fn images_table_migration_is_idempotent_on_populated_db() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("ladder on fresh db");
        // Seed a conversation row + an image row to prove the migration is
        // safe to re-run against a populated DB.
        conn.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('t', 0)",
            [],
        )
        .unwrap();
        let cid: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO images (conv_id, model, prompt, params_json, path, created_at)
             VALUES (?1, 'm', 'p', '{}', '/tmp/x.png', 0)",
            params![cid],
        )
        .unwrap();
        // Re-running the v10 step directly must not error or duplicate the
        // index.
        ensure_images_table(&conn).expect("v10 re-run 1");
        ensure_images_table(&conn).expect("v10 re-run 2");
        // Row is still there.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM images", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        // Index exists exactly once.
        let idx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_images_conv_created'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 1);
    }

    /// v28 (item 4A): the four checkpoint columns + (run_id, turn_index) index
    /// land via the ladder, and re-running the rung against a populated DB is a
    /// no-op (idempotent — the column_exists guards skip the ALTERs, the index
    /// is IF NOT EXISTS).
    #[test]
    fn checkpoint_columns_v28_install_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("ladder on fresh db");

        // All four columns present.
        for c in ["tool_call_id", "tool_name", "run_id", "turn_index"] {
            assert!(
                column_exists(&conn, "messages", c).unwrap(),
                "messages.{c} must exist after v28"
            );
        }
        // The (run_id, turn_index) index exists exactly once.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_messages_run_turn'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "checkpoint index present exactly once");

        // Seed a conversation + a normal message to prove a re-run is safe on a
        // populated DB, then drive the v28 apply body directly twice.
        conn.execute(
            "INSERT INTO conversations (title, created_at) VALUES ('t', 0)",
            [],
        )
        .unwrap();
        let cid: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at)
             VALUES (?1, 'user', 'hi', 0)",
            params![cid],
        )
        .unwrap();
        let v28 = MIGRATIONS
            .iter()
            .find(|m| m.version == 28)
            .expect("v28 rung exists");
        (v28.apply)(&conn).expect("v28 re-run 1 must not error");
        (v28.apply)(&conn).expect("v28 re-run 2 must not error");
        // Still exactly one index, and the seeded row survived.
        let idx2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='idx_messages_run_turn'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx2, 1);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// `checkpoint_run` writes turns atomically, is idempotent on
    /// (run_id, turn_index) — a re-run with the same run_id never duplicates —
    /// and checkpoint rows (run_id IS NOT NULL) are excluded from
    /// `list_messages`, so the visible conversation is unchanged (the no-double-
    /// write invariant). Uses the global DB (same as the other end-to-end tests).
    #[test]
    fn checkpoint_run_is_idempotent_and_invisible_to_list_messages() {
        let conv =
            create_conversation(&format!("__test_ckpt_{}", std::process::id()), None).unwrap();
        // One visible user turn (the normal addMessage path).
        add_message(conv, "user", "build me a thing", None, None).unwrap();
        let run = format!("run:test:{}", std::process::id());

        let turns = vec![
            CheckpointTurn {
                turn_index: 0,
                role: "assistant".into(),
                content: "{\"content\":\"working\",\"tool_calls\":[]}".into(),
                tool_call_id: None,
                tool_name: None,
                model: Some("m".into()),
            },
            CheckpointTurn {
                turn_index: 1,
                role: "tool".into(),
                content: "{\"ok\":true}".into(),
                tool_call_id: Some("call_1".into()),
                tool_name: Some("read_file".into()),
                model: None,
            },
        ];
        let n1 = checkpoint_run(&run, conv, &turns).unwrap();
        assert_eq!(n1, 2);

        // Re-run the SAME checkpoint (idempotent) — no duplication.
        let n2 = checkpoint_run(&run, conv, &turns).unwrap();
        assert_eq!(n2, 2);

        // The raw messages table holds: 1 visible user + 2 checkpoint rows.
        let total: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
                params![conv],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 3, "user turn + 2 checkpoint rows, no dup after re-run");

        // list_messages excludes checkpoint rows: only the visible user turn.
        let visible = list_messages(conv).unwrap();
        assert_eq!(visible.len(), 1, "checkpoint rows must be invisible");
        assert_eq!(visible[0].role, "user");

        // Extending the run (a later iteration) replaces the prior shadow.
        let mut more = turns.clone();
        more.push(CheckpointTurn {
            turn_index: 2,
            role: "assistant".into(),
            content: "done".into(),
            tool_call_id: None,
            tool_name: None,
            model: Some("m".into()),
        });
        let n3 = checkpoint_run(&run, conv, &more).unwrap();
        assert_eq!(n3, 3);
        let total2: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
                params![conv],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total2, 4, "1 user + 3 checkpoint rows after extend");
        assert_eq!(list_messages(conv).unwrap().len(), 1, "still 1 visible");

        delete_conversation(conv).unwrap();
    }

    /// RESUME (v30): `latest_unfinished_run` returns an open run's rehydrated
    /// turns, ordered by turn_index, with started/updated timestamps; `close_run`
    /// flips the set to finished so it is never re-offered; and the newest open
    /// run wins when more than one exists.
    #[test]
    fn latest_unfinished_run_reads_and_close_run_finishes() {
        let conv =
            create_conversation(&format!("__test_resume_{}", std::process::id()), None).unwrap();
        add_message(conv, "user", "build me a thing", None, None).unwrap();

        // No checkpoint yet → nothing to resume.
        assert!(latest_unfinished_run(conv).unwrap().is_none());

        let run = format!("run:resume:{}", std::process::id());
        let turns = vec![
            CheckpointTurn {
                turn_index: 0,
                role: "assistant".into(),
                content: "{\"content\":\"working\",\"tool_calls\":[{\"id\":\"c1\"}]}".into(),
                tool_call_id: None,
                tool_name: None,
                model: Some("m".into()),
            },
            CheckpointTurn {
                turn_index: 1,
                role: "tool".into(),
                content: "{\"ok\":true}".into(),
                tool_call_id: Some("c1".into()),
                tool_name: Some("read_file".into()),
                model: None,
            },
        ];
        checkpoint_run(&run, conv, &turns).unwrap();

        let open = latest_unfinished_run(conv).unwrap().expect("an open run");
        assert_eq!(open.run_id, run);
        assert_eq!(open.turns.len(), 2);
        assert_eq!(open.turns[0].turn_index, 0);
        assert_eq!(open.turns[0].role, "assistant");
        assert_eq!(open.turns[1].tool_name.as_deref(), Some("read_file"));
        assert!(open.updated_at >= open.started_at);

        // Close it → no longer offered, but the shadow rows survive.
        let flipped = close_run(&run, conv).unwrap();
        assert_eq!(flipped, 2);
        assert!(
            latest_unfinished_run(conv).unwrap().is_none(),
            "a closed run must not be offered for resume"
        );
        let surviving: i64 = get_db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1 AND run_id = ?2",
                params![conv, run],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(surviving, 2, "close keeps the rows, only flips run_done");

        // Re-closing is a benign no-op (0 rows flipped, already done).
        assert_eq!(close_run(&run, conv).unwrap(), 0);

        // A newer open run wins over an older one.
        let run2 = format!("run:resume2:{}", std::process::id());
        checkpoint_run(
            &run2,
            conv,
            &[CheckpointTurn {
                turn_index: 0,
                role: "assistant".into(),
                content: "second run".into(),
                tool_call_id: None,
                tool_name: None,
                model: Some("m".into()),
            }],
        )
        .unwrap();
        let newest = latest_unfinished_run(conv).unwrap().expect("newest open run");
        assert_eq!(newest.run_id, run2, "the most-recent open run is offered");

        delete_conversation(conv).unwrap();
    }

    /// RESUME (v30): a checkpoint row whose `run_done` is NULL (the pre-v30
    /// shape — an upgrade leaves prior interrupted runs' rows NULL) still counts
    /// as OPEN, so a run interrupted across the upgrade remains resumable.
    #[test]
    fn null_run_done_counts_as_open() {
        let conv =
            create_conversation(&format!("__test_resume_null_{}", std::process::id()), None)
                .unwrap();
        let run = format!("run:nullopen:{}", std::process::id());
        // Write a checkpoint row directly with run_done left NULL, simulating a
        // row persisted before v30 added the column.
        with_write(|tx| {
            tx.execute(
                "INSERT INTO messages
                    (conversation_id, role, content, created_at, run_id, turn_index, run_done)
                 VALUES (?1, 'assistant', 'pre-v30', 0, ?2, 0, NULL)",
                params![conv, run],
            )?;
            Ok(())
        })
        .unwrap();
        let open = latest_unfinished_run(conv)
            .unwrap()
            .expect("NULL run_done is open");
        assert_eq!(open.run_id, run);
        delete_conversation(conv).unwrap();
    }

    /// v28 invariant: agent checkpoint shadow rows (run_id IS NOT NULL) carry
    /// transient in-flight tool-result text the user never sees. They must stay
    /// out of BOTH global message searches — the FTS path
    /// (`search_messages_fts`, blocked at the index trigger + JOIN filter) and
    /// the sidebar LIKE path (`search_messages`, blocked at the MAX(id) subquery
    /// filter) — just as they're excluded from `list_messages`.
    #[test]
    fn checkpoint_shadows_excluded_from_message_search() {
        let tag = format!("zshadow{}", std::process::id());
        let conv =
            create_conversation(&format!("__test_shadow_{tag}"), None).unwrap();
        // One visible user turn whose body shares the marker token.
        add_message(conv, "user", &format!("please find {tag} now"), None, None).unwrap();
        // A checkpoint shadow whose body ALSO contains the marker — and has the
        // highest id in the conversation, so an unfiltered MAX(id) would pick it.
        let run = format!("run:shadow:{tag}");
        checkpoint_run(
            &run,
            conv,
            &[CheckpointTurn {
                turn_index: 0,
                role: "tool".into(),
                content: format!("secret transient {tag} tool-result blob"),
                tool_call_id: Some("call_1".into()),
                tool_name: Some("read_file".into()),
                model: None,
            }],
        )
        .unwrap();

        // FTS search returns ONLY the visible user message, never the shadow.
        let fts = search_messages_fts(tag.as_str(), 20).unwrap();
        assert!(
            fts.iter().any(|h| h.conversation_id == conv && h.role == "user"),
            "visible user turn must be searchable: {fts:?}"
        );
        assert!(
            !fts.iter().any(|h| h.role == "tool"),
            "checkpoint shadow must NOT appear in FTS search: {fts:?}"
        );

        // Sidebar LIKE search: the one hit per conversation must be the visible
        // user content, not the higher-id shadow blob.
        let like = search_messages(tag.as_str()).unwrap();
        let hit = like.iter().find(|h| h.conversation_id == conv);
        assert!(hit.is_some(), "conversation must surface in LIKE search");
        assert!(
            !hit.unwrap().snippet.contains("secret transient"),
            "LIKE search must not surface checkpoint shadow content: {:?}",
            hit.unwrap().snippet
        );

        delete_conversation(conv).unwrap();
    }

    /// `backfill_conv_id` must map ONLY purely-numeric legacy conversation_id
    /// values (matching the live-write path's strict `parse::<i64>()`). A value
    /// that merely starts with a digit ('12abc') must NOT be truncated to 12 and
    /// mis-mapped to an unrelated conversation.
    #[test]
    fn backfill_conv_id_is_whole_string_numeric_only() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("ladder on fresh db");
        // Two real conversations: ids 1 and 2 (AUTOINCREMENT from empty table).
        conn.execute("INSERT INTO conversations (title, created_at) VALUES ('a', 0)", [])
            .unwrap();
        let real = conn.last_insert_rowid();
        // agent_audit rows: a clean numeric ref, plus a digit-prefixed junk ref
        // that truncates to the real conv id. Both start with conv_id NULL.
        for (cid_text, _label) in [(real.to_string(), "numeric"), (format!("{real}abc"), "junk")] {
            conn.execute(
                "INSERT INTO agent_audit
                    (ts, conversation_id, tool_name, args_json, result_hash,
                     result_size, duration_ms, approval, outcome)
                 VALUES (1, ?1, 'read_file', '{}', 'h', 0, 1, 'auto', 'ok')",
                params![cid_text],
            )
            .unwrap();
        }
        // Re-run the backfill (rows were inserted after the v24 rung ran).
        backfill_conv_id(&conn, "agent_audit").unwrap();

        let numeric_mapped: i64 = conn
            .query_row(
                "SELECT conv_id FROM agent_audit WHERE conversation_id = ?1",
                params![real.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(numeric_mapped, real, "purely-numeric value maps correctly");

        let junk_mapped: Option<i64> = conn
            .query_row(
                "SELECT conv_id FROM agent_audit WHERE conversation_id = ?1",
                params![format!("{real}abc")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            junk_mapped, None,
            "digit-prefixed non-numeric value must NOT be truncated/mis-mapped"
        );
    }

    /// v20-v22 consolidation: the folded agent_audit / RAG / model_perf
    /// schemas land via the ladder (not a post-ladder DDL block), survive a
    /// populated re-run, and accept inserts against their canonical shapes.
    #[test]
    fn folded_schema_rungs_v20_to_v22_install_and_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("ladder on fresh db");
        // Seed one row in each folded table to prove a re-run is safe on a
        // populated DB.
        conn.execute(
            "INSERT INTO agent_audit
                (ts, conversation_id, tool_name, args_json, result_hash,
                 result_size, duration_ms, approval, outcome)
             VALUES (1, 'c1', 'read_file', '{}', 'h', 0, 1, 'auto', 'ok')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_session_metrics
                (ts, conversation_id, iterations, tool_calls, total_tool_ms,
                 total_llm_ms, prompt_tokens, completion_tokens)
             VALUES (1, 'c1', 1, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rag_corpora (name, root_path, created_at, updated_at)
             VALUES ('c', '/tmp', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO model_perf_samples
                (ts, model, backend, ttft_ms, tok_per_sec, completion_tokens)
             VALUES (1, 'm', 'mlx', 10, 5.0, 3)",
            [],
        )
        .unwrap();
        // Re-running the ladder must be a no-op that doesn't drop the rows.
        run_migrations(&conn).expect("second run is a no-op");
        let n = |t: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(n("agent_audit"), 1);
        assert_eq!(n("agent_session_metrics"), 1);
        assert_eq!(n("rag_corpora"), 1);
        assert_eq!(n("model_perf_samples"), 1);
        // The v21-guarded embedder column carries its default on the seeded row.
        let embedder: String = conn
            .query_row("SELECT embedder FROM rag_corpora LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(embedder, "hashed-v1");
    }

    /// WS2: conv_id reconciliation. Build a DB whose `agent_audit` predates the
    /// conv_id sibling, seed numeric-valid / non-numeric / orphan-numeric TEXT
    /// `conversation_id` rows, run the v24 migration, and assert the backfill:
    /// numeric-valid → backfilled, others → NULL. Then (if the FK landed)
    /// deleting the conversation nulls conv_id without deleting the audit row.
    #[test]
    fn conv_id_backfill_and_set_null_on_delete() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // Conversations table (v1 shape) + one live conversation, id 7.
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES (7, 't', 0)",
            [],
        )
        .unwrap();
        // Pre-conv_id agent_audit shape (no conv_id column).
        conn.execute_batch(
            "CREATE TABLE agent_audit (
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
            );",
        )
        .unwrap();
        let seed = |cid: Option<&str>| {
            conn.execute(
                "INSERT INTO agent_audit
                    (ts, conversation_id, tool_name, args_json, result_hash,
                     result_size, duration_ms, approval, outcome)
                 VALUES (1, ?1, 't', '{}', 'h', 0, 1, 'auto', 'ok')",
                params![cid],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let numeric_id = seed(Some("7")); // valid, live conversation
        let nonnumeric_id = seed(Some("abc-uuid")); // non-numeric → NULL
        let orphan_id = seed(Some("999")); // numeric but no such conversation → NULL
        let none_id = seed(None); // NULL TEXT → NULL

        // Run only the conv_id-adding migration logic directly.
        assert!(!column_exists(&conn, "agent_audit", "conv_id").unwrap());
        add_conv_id_column(&conn, "agent_audit").unwrap();
        backfill_conv_id(&conn, "agent_audit").unwrap();
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_agent_audit_conv_id ON agent_audit(conv_id);",
        )
        .unwrap();

        let conv_id_of = |id: i64| -> Option<i64> {
            conn.query_row(
                "SELECT conv_id FROM agent_audit WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(conv_id_of(numeric_id), Some(7), "numeric-valid backfilled");
        assert_eq!(conv_id_of(nonnumeric_id), None, "non-numeric stays NULL");
        assert_eq!(conv_id_of(orphan_id), None, "orphan-numeric stays NULL");
        assert_eq!(conv_id_of(none_id), None, "NULL TEXT stays NULL");

        // Re-running the backfill is idempotent (only fills NULL rows).
        backfill_conv_id(&conn, "agent_audit").unwrap();
        assert_eq!(conv_id_of(numeric_id), Some(7));

        // Deleting the conversation must null conv_id (whether the inline FK is
        // enforced by this SQLite build OR the app-layer UPDATE handles it) and
        // must NOT delete the forensic audit row.
        let fk_enforced =
            column_exists(&conn, "agent_audit", "conv_id").unwrap() && {
                // App-layer null mirrors delete_conversation's WS2 sweep.
                conn.execute(
                    "UPDATE agent_audit SET conv_id = NULL WHERE conv_id = 7",
                    [],
                )
                .unwrap();
                conn.execute("DELETE FROM conversations WHERE id = 7", [])
                    .unwrap();
                true
            };
        assert!(fk_enforced);
        assert_eq!(conv_id_of(numeric_id), None, "conv_id nulled on parent delete");
        let audit_still_there: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_audit WHERE id = ?1",
                params![numeric_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(audit_still_there, 1, "audit row survives conversation delete");
    }

    /// Running the ladder a second time on an already-migrated DB is a no-op:
    /// no error, version unchanged, schema unchanged.
    #[test]
    fn migration_ladder_is_idempotent() {
        let conn = test_open_in_memory_with_vec();
        run_migrations(&conn).expect("first run");
        let v1 = user_version(&conn);
        run_migrations(&conn).expect("second run must be a no-op");
        run_migrations(&conn).expect("third run must be a no-op");
        assert_eq!(user_version(&conn), v1);
        assert_final_schema(&conn);
        // Seed + backfill twice — the vec backfill (INSERT OR IGNORE) is
        // idempotent, so a second runtime ensure is a clean no-op.
        assert_vec_tables_after_seed(&conn);
        if vec0_available() {
            ensure_vec_tables_present(&conn).expect("second runtime backfill is a no-op");
        }
    }

    /// An old-shape DB — base tables only, user_version 0, pre-images/params —
    /// upgrades cleanly through the ladder with no data loss.
    #[test]
    fn migration_ladder_upgrades_old_db() {
        let conn = test_open_in_memory_with_vec();
        // Pre-ladder shape: v1 base tables, never version-stamped.
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE memories (
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
        .unwrap();
        // Seed real rows so we can prove they survive the upgrade.
        conn.execute(
            "INSERT INTO conversations (title, model, created_at) VALUES ('old chat', 'm', 100)",
            [],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at)
             VALUES (?1, 'user', 'hello from the past', 101)",
            params![cid],
        )
        .unwrap();
        assert_eq!(user_version(&conn), 0);

        run_migrations(&conn).expect("upgrade old db");

        assert_eq!(user_version(&conn), latest_version());
        assert_final_schema(&conn);
        // Data preserved.
        let (title, content): (String, String) = conn
            .query_row(
                "SELECT c.title, m.content FROM conversations c
                 JOIN messages m ON m.conversation_id = c.id WHERE c.id = ?1",
                params![cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "old chat");
        assert_eq!(content, "hello from the past");
        // New columns have their defaults on the migrated row.
        let pinned: i64 = conn
            .query_row(
                "SELECT pinned FROM conversations WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pinned, 0);
    }

    #[test]
    fn org_columns_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_org_columns(&conn).expect("first");
        ensure_conversation_org_columns(&conn).expect("second");
        ensure_conversation_org_columns(&conn).expect("third");
        assert!(column_exists(&conn, "conversations", "pinned").unwrap());
        assert!(column_exists(&conn, "conversations", "tags").unwrap());
    }

    /// `validate_tags_json` accepts only `None` or a JSON array of strings.
    #[test]
    fn tags_json_validation() {
        assert!(validate_tags_json(None).is_ok());
        assert!(validate_tags_json(Some("[]")).is_ok());
        assert!(validate_tags_json(Some(r#"["work","urgent"]"#)).is_ok());
        // Malformed JSON.
        assert!(validate_tags_json(Some("[not json")).is_err());
        // Valid JSON but not an array.
        assert!(validate_tags_json(Some(r#"{"a":1}"#)).is_err());
        assert!(validate_tags_json(Some("42")).is_err());
        // Array with non-string elements.
        assert!(validate_tags_json(Some("[1,2,3]")).is_err());
        assert!(validate_tags_json(Some(r#"["ok",5]"#)).is_err());
        assert!(validate_tags_json(Some(r#"["ok",null]"#)).is_err());
    }

    #[test]
    fn escape_like_escapes_wildcards() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("c:\\path"), "c:\\\\path");
        assert_eq!(escape_like("plain"), "plain");
    }

    #[test]
    fn snippet_is_capped_and_centred() {
        let short = "a short message";
        assert_eq!(make_snippet(short, "short"), short);
        let long = format!("{} needle {}", "x ".repeat(200), "y ".repeat(200));
        let snip = make_snippet(&long, "needle");
        assert!(snip.chars().count() <= SEARCH_SNIPPET_CHARS + 2);
        assert!(snip.to_lowercase().contains("needle"));
    }

    #[test]
    fn snippet_handles_lowercase_byte_length_change_without_panic() {
        // 'İ' (U+0130) lowercases to 2 chars ("i̇"). Before the fix, a byte
        // offset into the lowercased form was used to slice the original →
        // misaligned, panic. Many such chars BEFORE the needle is the trigger.
        let content = format!("{} needle here", "İ ".repeat(120));
        let snip = make_snippet(&content, "needle"); // must not panic
        assert!(snip.chars().count() <= SEARCH_SNIPPET_CHARS + 2);
        // A needle that is itself a byte-length-changing char must also work.
        let _ = make_snippet(&format!("{} İ tail", "a ".repeat(200)), "İ");
    }

    #[test]
    fn fork_columns_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_fork_columns(&conn).expect("first");
        ensure_conversation_fork_columns(&conn).expect("second");
        ensure_conversation_fork_columns(&conn).expect("third");
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'parent_conv_id'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);
    }
}
