//! Project RAG — local folder ingestion + semantic search.
//!
//! Embedding strategy: **feature-hashed bag-of-words** with L2 normalization.
//! This is a TF-IDF-flavored hashed vectorizer — deterministic, dependency-free,
//! fast, and good enough for keyword/structural similarity over code &
//! documentation. It is NOT a learned embedding — synonyms / paraphrases will
//! miss. We picked this because:
//!   * ONNX runtime adds ~25 MB of bundled libs and a non-trivial cmake build.
//!   * BGE-small requires shipping a tokenizer (HF tokenizers crate) which
//!     also adds build weight.
//!   * The agent surface (search_project_knowledge) is identical regardless
//!     of embedding quality — swappable later behind the same DB schema.
//!
//! TODO(embed): swap hashed-TF for ONNX BAAI/bge-small-en-v1.5 in v1.3.

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use parking_lot::Mutex as PLMutex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::history::{get_db, now_unix};

/* ───────────────────────────────────────────────────────────────────────────
Memoized `vec_rag_chunks` declared dimension. Mirrors `memory::VEC_MEM_DIM_MEMO`.
`history::vec0_usable_for` runs TWO sqlite_master metadata queries (table_exists
+ a CREATE-SQL fetch + parse) on EVERY RAG search, but the shared vec0 table's
dim is process-stable: it only changes when the table is dropped (embedder switch
→ `vec_drop_table` at the re-ingest drop site, which resets this memo) or first
created (lazy `flush_pending`, picked up by the re-probe on a still-UNKNOWN
value). Caching the resolved dim turns the hot search path into a single
in-memory load + integer compare. Perf finding (2026-06).

State: `UNKNOWN` (-1) = not yet learned → probe + cache on success; a positive
value = the table's declared dim. We only ever cache a *positive* dim (a table
that exists), so a not-yet-created table stays UNKNOWN and a later create is
detected; a drop is handled by the explicit reset at the embedder-switch site.
─────────────────────────────────────────────────────────────────────── */
const RAG_MEMO_UNKNOWN: i64 = -1;
static VEC_RAG_DIM_MEMO: AtomicI64 = AtomicI64::new(RAG_MEMO_UNKNOWN);

/// Reset the memoized vec_rag_chunks dim so the next search re-probes the schema.
/// Called whenever the shared vec0 table may have been dropped/recreated at a new
/// dim (embedder switch on re-ingest).
fn reset_vec_rag_dim_memo() {
    VEC_RAG_DIM_MEMO.store(RAG_MEMO_UNKNOWN, Ordering::Relaxed);
}

/// Can vec0 KNN serve a query of `query_dim` against `vec_rag_chunks`, using the
/// memoized declared dim to skip the per-search sqlite_master probes once known?
/// On a cache miss, falls back to the authoritative `vec0_usable_for` probe and
/// caches the table's dim (when it resolves to a positive value).
fn vec0_rag_usable(conn: &rusqlite::Connection, query_dim: usize) -> bool {
    if query_dim == 0 || !crate::history::vec0_available() {
        return false;
    }
    let cached = VEC_RAG_DIM_MEMO.load(Ordering::Relaxed);
    if cached > 0 {
        return cached as usize == query_dim;
    }
    // Unknown: read the table's declared dim once (the single schema probe the
    // memo amortizes). `vec_table_dim` returns None when the table is absent →
    // leave the memo UNKNOWN so a later lazy-create is picked up; otherwise cache
    // the dim so subsequent searches skip the probe entirely.
    match crate::history::vec_table_dim(conn, crate::history::VEC_RAG_CHUNKS) {
        Some(dim) => {
            VEC_RAG_DIM_MEMO.store(dim as i64, Ordering::Relaxed);
            dim == query_dim
        }
        None => false,
    }
}

/// Per-corpus-name mutex registry. Two concurrent ingest calls for the
/// same corpus name would otherwise race the wipe + insert: the
/// transaction wrap in pass 5 narrowed but didn't eliminate the window
/// (call A finishes its wipe and first inserts, then call B runs its own
/// wipe and clobbers A's just-inserted chunks). The per-name lock
/// serializes the full ingest pipeline for one corpus; different corpora
/// still proceed in parallel. Audit re-review MEDIUM (2026-05-28).
static INGEST_LOCKS: Lazy<PLMutex<HashMap<String, Arc<PLMutex<()>>>>> =
    Lazy::new(|| PLMutex::new(HashMap::new()));

fn ingest_lock_for(name: &str) -> Arc<PLMutex<()>> {
    let mut reg = INGEST_LOCKS.lock();
    reg.entry(name.to_string())
        .or_insert_with(|| Arc::new(PLMutex::new(())))
        .clone()
}

/// Fixed embedding dimensionality. Higher → less hash collision but more
/// storage per chunk (4 bytes × dim). 512 → 2 KB/chunk; 50k chunks ≈ 100 MB.
pub const EMBED_DIM: usize = 512;

const MAX_CHUNK_CHARS: usize = 512;
const CHUNK_OVERLAP_CHARS: usize = 64;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB — skip giant files
const MAX_CHUNKS_PER_INGEST: usize = 200_000;

/// Directories we always skip — VCS, package caches, build artifacts.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".idea",
    ".vscode",
    "vendor",
];

/// File extensions we ingest. Everything else is skipped — keeps binaries out.
const TEXT_EXTS: &[&str] = &[
    "md", "txt", "rst", "adoc", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go",
    "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php", "lua", "sh", "bash", "zsh",
    "fish", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "html", "htm", "css",
    "scss", "sass", "less", "sql", "graphql", "gql", "proto", "tex", "bib",
    // Act 2 (2026-06-10): PDFs enter the pipeline via pdf-extract.
    "pdf",
];

/* ───────────────────────────── Schema ────────────────────────────────── */

pub fn ensure_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rag_corpora (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            root_path TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS rag_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            corpus_id INTEGER NOT NULL REFERENCES rag_corpora(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_rag_chunks_corpus ON rag_chunks(corpus_id);
         CREATE INDEX IF NOT EXISTS idx_rag_chunks_corpus_path ON rag_chunks(corpus_id, path);
         CREATE TABLE IF NOT EXISTS rag_files (
            corpus_id INTEGER NOT NULL REFERENCES rag_corpora(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            mtime_ms INTEGER NOT NULL,
            size INTEGER NOT NULL,
            PRIMARY KEY (corpus_id, path)
         );",
    )?;
    // Act 2 (2026-06-10): which embedder produced this corpus's vectors.
    // Old DBs lack the column. Guard the ALTER with `column_exists` so a real
    // failure surfaces instead of being swallowed by a bare `let _ =`
    // (consolidation pass 2026-06-13 — this is the v21 ladder rung body too).
    if !crate::history::column_exists(conn, "rag_corpora", "embedder")? {
        conn.execute(
            "ALTER TABLE rag_corpora ADD COLUMN embedder TEXT NOT NULL DEFAULT 'hashed-v1'",
            [],
        )?;
    }
    Ok(())
}

/// v21 ladder rung: install the RAG schema in migration-version order. Thin
/// alias over `ensure_schema` (which is already idempotent + guarded) so the
/// `Migration { apply: ... }` slot has a stable function pointer and the
/// connection-scoped `ensure_schema` stays callable from the in-memory test
/// paths that bypass the ladder.
pub(crate) fn ensure_schema_rung(conn: &rusqlite::Connection) -> Result<()> {
    ensure_schema(conn)
}

/* ───────────────────────── Sparse (FTS5) index ──────────────────────────
 *
 * W5-RAGCORE (2026-06-15): a BM25 keyword index over `rag_chunks.text`, fused
 * with the existing dense vector path via Reciprocal Rank Fusion (see
 * `search`). Pure dense retrieval misses exact identifiers and error codes
 * ("E0277", "TS2345", `useChatSend`) whose surface form carries the signal but
 * whose learned/hashed embedding washes out; BM25 nails them.
 *
 * FORWARD-ONLY + NON-DESTRUCTIVE: this is an additive, derived, fully
 * rebuildable index — `rag_chunks` (text + BLOB) stays the source of truth,
 * exactly like the vec0 derived index. It is NOT created by a migration that
 * touches stored data. Instead it is built lazily on first hybrid search (and
 * kept in lockstep during ingest), so existing corpora that predate it keep
 * working: when the FTS table is absent or empty for a corpus, `search` simply
 * falls back to the dense-only path it used before. A user re-ingest (the
 * RagPanel re-index button) fully repopulates it.
 *
 * External-content FTS5 (`content='rag_chunks'`, `content_rowid='id'`) keeps
 * the index small — it references the chunk rowid rather than duplicating chunk
 * bodies. We deliberately do NOT install sync triggers (those would live in
 * history.rs, which this group does not own); instead every rag.rs write path
 * that mutates `rag_chunks` mirrors the change into the FTS index inside the
 * SAME transaction (ingest flush, copy-forward, atomic swap, delete), and a
 * one-shot `rebuild` backfills any pre-existing rows on first use.
 */

/// Name of the external-content FTS5 table mirroring `rag_chunks.text`.
pub(crate) const RAG_FTS: &str = "rag_chunks_fts";

/// Create the FTS5 table if missing. `tokenize` is `porter unicode61` to mirror
/// `messages_fts`'s stemming, but we keep `remove_diacritics 2` off the default
/// and add `tokenchars '_'` so snake_case identifiers (`with_write`,
/// `EMBED_DIM`) index as whole tokens rather than being split on the
/// underscore — exact-identifier recall is the whole point of the sparse leg.
/// No-op-safe: `IF NOT EXISTS`. Returns Ok even on a build without FTS5 only if
/// the CREATE itself succeeds; callers treat any error as "sparse unavailable"
/// and fall back to dense-only.
fn ensure_fts_table(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS {RAG_FTS} USING fts5(
            text,
            content='rag_chunks',
            content_rowid='id',
            tokenize=\"porter unicode61 tokenchars '_'\"
         );"
    ))?;
    Ok(())
}

/// Whether the FTS table exists AND already holds at least one row. Empty /
/// absent → the caller skips the sparse leg (dense-only), so a pre-existing
/// corpus that has never been (re)indexed since this feature shipped keeps its
/// old behavior with zero migration. Best-effort: any error reads as "no".
fn fts_has_rows(conn: &rusqlite::Connection) -> bool {
    // `SELECT 1 FROM <fts> LIMIT 1` errors if the table is absent — treat as no.
    conn.query_row(&format!("SELECT 1 FROM {RAG_FTS} LIMIT 1"), [], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Lazily build (and one-time backfill) the FTS index from `rag_chunks`, used on
/// the first hybrid search against a DB whose corpora predate the index.
/// Idempotent and best-effort: returns `true` when the sparse leg is usable
/// afterward, `false` when FTS5 is unavailable or the build failed (caller then
/// uses dense-only).
///
/// The `rebuild` command re-derives every row from the external-content source
/// (`rag_chunks`), so it is safe to call repeatedly and never duplicates rows.
/// Runs through the single-writer gate since it writes the (shared) FTS table.
fn ensure_fts_populated(conn: &rusqlite::Connection) -> bool {
    if fts_has_rows(conn) {
        return true;
    }
    // No FTS rows. If there are no chunks AT ALL to index, skip the rebuild
    // entirely: there is nothing to backfill, the dense path will return nothing
    // anyway, and a per-search no-op `with_write` would be wasteful churn. (The
    // ingest path creates + populates the index in lockstep, so a real corpus
    // never depends on this lazy build to get its rows.) Returning false here
    // just means "use dense-only this call" — harmless when the corpus is empty.
    let any_chunks: bool = conn
        .query_row("SELECT 1 FROM rag_chunks LIMIT 1", [], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some();
    if !any_chunks {
        return false;
    }
    // Legacy DB whose chunks predate the index → one-time backfill. `rebuild`
    // re-derives the whole index from the content table (a one-time O(corpus)
    // cost), then `fts_has_rows` is true on every subsequent search.
    let built = crate::history::with_write(|tx| {
        ensure_fts_table(tx)?;
        tx.execute_batch(&format!(
            "INSERT INTO {RAG_FTS}({RAG_FTS}) VALUES ('rebuild');"
        ))?;
        Ok(())
    });
    match built {
        Ok(()) => true,
        Err(e) => {
            crate::diagnostics::warn_with(
                "rag",
                "FTS index build failed — hybrid search falls back to dense-only",
                serde_json::json!({ "error": e.to_string() }),
            );
            false
        }
    }
}

/// Mirror an inserted chunk into the FTS index inside the caller's tx. External-
/// content FTS5 wants the SAME rowid + column value as the content row. Best-
/// effort: a failure (no FTS5, transient) leaves `rag_chunks` authoritative and
/// the next `rebuild` recovers it; never propagated so a chunk write isn't lost.
fn fts_insert_chunk(tx: &rusqlite::Transaction<'_>, chunk_id: i64, text: &str) {
    if ensure_fts_table(tx).is_err() {
        return;
    }
    let _ = tx.execute(
        &format!("INSERT INTO {RAG_FTS}(rowid, text) VALUES (?1, ?2)"),
        params![chunk_id, text],
    );
}

/// Mirror the copy-forward path's above-watermark chunks into the FTS index in
/// the same tx (parallels `vec_backfill_rag_above`). Best-effort.
fn fts_backfill_above(tx: &rusqlite::Transaction<'_>, corpus_id: i64, path: &str, watermark: i64) {
    if ensure_fts_table(tx).is_err() {
        return;
    }
    let _ = tx.execute(
        &format!(
            "INSERT INTO {RAG_FTS}(rowid, text)
             SELECT id, text FROM rag_chunks
             WHERE corpus_id = ?1 AND path = ?2 AND id > ?3"
        ),
        params![corpus_id, path, watermark],
    );
}

/// Delete the FTS rows for a corpus's OLD generation (chunks at/below the
/// watermark), mirroring `vec_delete_rag_old_generation`. External-content FTS5
/// needs the original `text` to remove an entry cleanly, so we issue the special
/// `('delete', rowid, text)` form joined back to the still-present content rows.
/// Must run BEFORE the rag_chunks delete so the join still resolves. Best-effort.
fn fts_delete_old_generation(tx: &rusqlite::Transaction<'_>, corpus_id: i64, watermark: i64) {
    if !fts_has_rows(tx) {
        return;
    }
    let _ = tx.execute(
        &format!(
            "INSERT INTO {RAG_FTS}({RAG_FTS}, rowid, text)
             SELECT 'delete', id, text FROM rag_chunks
             WHERE corpus_id = ?1 AND id <= ?2"
        ),
        params![corpus_id, watermark],
    );
}

/// Delete all FTS rows for a corpus (used by delete_corpus before the FK cascade
/// drops the rag_chunks rows). Mirrors `vec_delete_rag_corpus`. Best-effort.
fn fts_delete_corpus(tx: &rusqlite::Transaction<'_>, corpus_id: i64) {
    if !fts_has_rows(tx) {
        return;
    }
    let _ = tx.execute(
        &format!(
            "INSERT INTO {RAG_FTS}({RAG_FTS}, rowid, text)
             SELECT 'delete', id, text FROM rag_chunks WHERE corpus_id = ?1"
        ),
        params![corpus_id],
    );
}

/* ─────────────────────────── Types ──────────────────────────────────── */

#[derive(Serialize, Clone, Debug)]
pub struct CorpusInfo {
    pub id: i64,
    pub name: String,
    pub root_path: String,
    pub chunk_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Whether the corpus's source folder has drifted since its last ingest.
    ///
    /// W4-RAG3 (2026-06-15): DELIBERATELY not populated by `list_corpora` —
    /// computing it walks + stats every file under each corpus root, which is
    /// far too heavy to do for every corpus on every list call. It is computed
    /// on demand by `corpus_stale` (exposed via the `rag_corpus_stale` command,
    /// which the RagPanel calls lazily per row). `skip_serializing_if` keeps the
    /// field absent from the cheap list payload so the TS side sees `undefined`
    /// rather than a misleading `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
pub struct IngestReport {
    pub corpus_id: i64,
    pub files_seen: usize,
    pub files_indexed: usize,
    pub chunks_created: usize,
    pub total_bytes: u64,
    pub duration_ms: u128,
}

#[derive(Serialize, Clone, Debug)]
pub struct RagHit {
    pub path: String,
    pub snippet: String,
    pub score: f32,
    pub start_byte: i64,
    pub end_byte: i64,
}

#[derive(Deserialize, Debug)]
pub struct IngestOpts {
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub glob: Option<String>,
}

/* ─────────────────────────── Chunking ───────────────────────────────── */

/// Below this many chars a structural segment is glued onto the next one
/// instead of becoming its own chunk — keeps a lone heading / one-line
/// paragraph from polluting the index with near-empty vectors.
const MIN_CHUNK_CHARS: usize = 64;

/// Split `text` into chunks of at most `MAX_CHUNK_CHARS` characters with
/// `CHUNK_OVERLAP_CHARS` of overlap between adjacent chunks.
///
/// Structure-aware (2026-06-15, W2-RAG): rather than slicing blind
/// `MAX_CHUNK_CHARS` windows, we first cut the text at natural boundaries —
/// markdown headings (`#`, `##`, …), blank-line paragraph breaks, and
/// code-block boundaries (a line that opens a `def`/`fn`/`class`/`function`
/// or whose only non-space content is `{`/`}`). Adjacent boundary segments are
/// then packed greedily up to `MAX_CHUNK_CHARS`, and any single segment longer
/// than the cap is sub-split with the original sliding-window-with-overlap so
/// the cap is never exceeded. The output contract is UNCHANGED — a list of
/// `(start_byte, end_byte, chunk_text)` on char boundaries — so the embedder,
/// the stored schema, and the linear-fallback scoring all behave identically;
/// only the *grouping* of source text into chunks improves. This affects new
/// ingests only; previously-stored chunks are never re-cut.
///
/// Empty / whitespace-only inputs return an empty Vec.
pub fn chunk_text(text: &str) -> Vec<(usize, usize, String)> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    // Pass 1: cut into boundary-aligned segments as (start_byte, end_byte).
    let segments = boundary_segments(text);
    // Pass 2: pack segments greedily up to the cap; emit (with cap-respecting
    // sub-splitting for oversized single segments).
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut cur_start: Option<usize> = None;
    let mut cur_end: usize = 0;
    let mut cur_chars: usize = 0;
    let flush = |start: usize, end: usize, out: &mut Vec<(usize, usize, String)>| {
        let slice = &text[start..end];
        if slice.trim().is_empty() {
            return;
        }
        // An oversized packed run (a single huge segment) is sub-split with the
        // sliding window so the cap holds and adjacent sub-chunks overlap.
        if slice.chars().count() > MAX_CHUNK_CHARS {
            window_split(text, start, end, out);
        } else {
            out.push((start, end, slice.to_string()));
        }
    };
    for (s, e, strong) in segments {
        let seg_chars = text[s..e].chars().count();
        match cur_start {
            None => {
                cur_start = Some(s);
                cur_end = e;
                cur_chars = seg_chars;
            }
            Some(start) => {
                // Flush-and-restart when EITHER (a) appending would overflow the
                // cap (and the current run is already at least MIN, so we don't
                // emit a runt), OR (b) this segment opens a STRONG structural
                // boundary (a heading / code definition) and the current run is
                // already substantial — so headings genuinely LEAD a chunk
                // instead of being glued onto the prior section's tail. A soft
                // (paragraph) boundary only splits on overflow, which keeps
                // related prose packed. (Whitespace between segments is
                // preserved because segments are contiguous byte ranges.)
                let would_overflow = cur_chars + seg_chars > MAX_CHUNK_CHARS;
                let split_here = (would_overflow || strong) && cur_chars >= MIN_CHUNK_CHARS;
                if split_here {
                    flush(start, cur_end, &mut out);
                    cur_start = Some(s);
                    cur_end = e;
                    cur_chars = seg_chars;
                } else {
                    cur_end = e;
                    cur_chars += seg_chars;
                }
            }
        }
    }
    if let Some(start) = cur_start {
        flush(start, cur_end, &mut out);
    }
    out
}

/// Cut `[0, text.len())` into byte ranges aligned to structural boundaries:
/// a new segment begins at a markdown heading line, after a blank-line
/// paragraph break, and at a code def/`{`/`}` boundary line. Ranges are
/// contiguous and cover the whole input (no bytes dropped), and every cut sits
/// on a line boundary (which is always a char boundary), so downstream slicing
/// is UTF-8 safe.
///
/// Each returned range carries a `strong` flag: `true` when the segment OPENS
/// at a heading or code-definition line (a hard structural boundary), `false`
/// for a plain paragraph break. The packer flushes eagerly on a strong
/// boundary so headings lead chunks, but only on overflow for soft ones.
fn boundary_segments(text: &str) -> Vec<(usize, usize, bool)> {
    // (offset, strong). The leading 0 is the implicit document start.
    let mut cuts: Vec<(usize, bool)> = vec![(0, true)];
    let mut offset = 0usize;
    let mut prev_blank = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let strong = is_heading_line(trimmed) || is_code_boundary_line(trimmed);
        let is_boundary_start = strong || (prev_blank && !trimmed.is_empty());
        if is_boundary_start && offset != 0 {
            cuts.push((offset, strong));
        }
        prev_blank = trimmed.is_empty();
        offset += line.len();
    }
    cuts.push((text.len(), false));
    // Sort by offset; on a duplicate offset keep the strong flag (a heading that
    // also follows a blank line). Then pair consecutive cuts into ranges where
    // the range's `strong` is the flag of its OPENING cut.
    cuts.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    cuts.dedup_by_key(|c| c.0);
    cuts.windows(2)
        .filter(|w| w[1].0 > w[0].0)
        .map(|w| (w[0].0, w[1].0, w[0].1))
        .collect()
}

/// A markdown ATX heading line: 1–6 leading `#` then a space (or EOL).
fn is_heading_line(trimmed: &str) -> bool {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes)
        && trimmed[hashes..]
            .chars()
            .next()
            .map_or(trimmed.len() == hashes, |c| c == ' ')
}

/// A code structural boundary: a line that opens a definition (rust `fn`/
/// `struct`/`enum`/`impl`/`trait`/`mod`, py/js `def`/`class`/`function`) or a
/// line whose only non-space content is a single brace.
fn is_code_boundary_line(trimmed: &str) -> bool {
    if trimmed == "{" || trimmed == "}" {
        return true;
    }
    const DEF_KW: &[&str] = &[
        "fn ",
        "pub fn ",
        "async fn ",
        "pub async fn ",
        "struct ",
        "pub struct ",
        "enum ",
        "pub enum ",
        "impl ",
        "trait ",
        "pub trait ",
        "mod ",
        "pub mod ",
        "def ",
        "async def ",
        "class ",
        "function ",
        "export function ",
    ];
    DEF_KW.iter().any(|kw| trimmed.starts_with(kw))
}

/// Sub-split a single oversized byte range with the original sliding window
/// (`MAX_CHUNK_CHARS` cap, `CHUNK_OVERLAP_CHARS` overlap), operating on char
/// boundaries within `text[range_start..range_end]`. Pure-whitespace tail
/// slices are dropped. This is the verbatim pre-2026-06-15 windowing, scoped
/// to a sub-range so the boundary packer can lean on it for huge segments.
fn window_split(
    text: &str,
    range_start: usize,
    range_end: usize,
    out: &mut Vec<(usize, usize, String)>,
) {
    let sub = &text[range_start..range_end];
    let chars: Vec<(usize, char)> = sub.char_indices().collect();
    let n = chars.len();
    if n == 0 {
        return;
    }
    let mut start = 0usize;
    while start < n {
        let end = (start + MAX_CHUNK_CHARS).min(n);
        let start_byte = range_start + chars[start].0;
        let end_byte = if end == n {
            range_end
        } else {
            range_start + chars[end].0
        };
        let slice = &text[start_byte..end_byte];
        if !slice.trim().is_empty() {
            out.push((start_byte, end_byte, slice.to_string()));
        }
        if end == n {
            break;
        }
        let step = MAX_CHUNK_CHARS.saturating_sub(CHUNK_OVERLAP_CHARS).max(1);
        start += step;
    }
}

/* ─────────────────────────── Embedding ──────────────────────────────── */

/// Hash a token into the [0, EMBED_DIM) range. FNV-1a 64-bit — fast,
/// dependency-free, and stable across runs (deterministic ingestion).
fn hash_token(tok: &str) -> usize {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in tok.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (h as usize) % EMBED_DIM
}

/// Tokenize: lowercase, split on non-alphanumeric, drop length-1 tokens.
/// `code_` and `code-aware` heuristics: also yield camelCase splits and
/// snake_case pieces so identifiers contribute multiple features.
fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut toks = Vec::new();
    let mut cur = String::new();
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            cur.push(ch);
        } else {
            if cur.len() >= 2 {
                toks.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        toks.push(cur);
    }
    toks
}

/// Embed text via feature hashing + L2 normalize. Returns a vector of
/// length EMBED_DIM. Empty / whitespace input → zero vector (cosine 0).
pub fn embed(text: &str) -> Vec<f32> {
    let mut v = vec![0.0f32; EMBED_DIM];
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return v;
    }
    // Sub-linear TF — damp the influence of repeated tokens (classic TF-IDF
    // trick; full IDF would require a corpus pass we're skipping for v1.2).
    let mut counts: HashMap<usize, f32> = HashMap::new();
    for t in &tokens {
        *counts.entry(hash_token(t)).or_insert(0.0) += 1.0;
    }
    for (idx, c) in counts {
        v[idx] = 1.0 + c.ln();
    }
    // L2 normalize
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v
}

/// Cosine similarity over pre-normalized vectors.
///
/// CONTRACT: both inputs MUST be L2-normalized; the function collapses
/// cosine to a dot product for speed. Calling this with un-normalized
/// vectors silently returns incorrect scores (no guard for performance).
///
/// All vectors flowing through this module pass through `embed()`, which
/// guarantees L2 normalization (lines 222-227 above). If a future caller
/// pulls embeddings from a different source — Ollama's nomic-embed-text,
/// for example — verify normalization at the source OR use the safer
/// `memory::cosine`, which normalizes inputs itself.
///
/// In debug builds, asserts the inputs really are unit-length so a
/// future regression in the embedding pipeline fails loudly instead of
/// silently misranking results.
#[cfg(test)]
pub fn cosine_normalized(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    // Zero vectors (empty / whitespace text → embed() returns all-zero)
    // are well-defined: cosine(0, x) = 0. Short-circuit BEFORE the
    // unit-length assert because `is_unit_length` considers a zero vector
    // non-unit (sq=0, |sq-1|=1, > 1e-3). Without this skip, the
    // legitimate "compare against empty embedding" path tripped the
    // debug_assert in CI.
    let a_is_zero = a.iter().all(|x| *x == 0.0);
    let b_is_zero = b.iter().all(|x| *x == 0.0);
    if a_is_zero || b_is_zero {
        return 0.0;
    }
    debug_assert!(
        is_unit_length(a) && is_unit_length(b),
        "rag::cosine_normalized called with un-normalized input"
    );
    // Release-mode safety net: if a future regression breaks the
    // normalization invariant (embedder swap, custom corpus import,
    // ONNX integration that doesn't normalize), the debug_assert above
    // would catch it locally but not in production. Sample at the
    // lowest cost we can get away with — once per process via Once —
    // and emit one diag rather than per-call (which would spam the
    // ring buffer). The non-normalized result is still returned so
    // ranking continues to work; the log is a breadcrumb for triage.
    if !is_unit_length(a) || !is_unit_length(b) {
        static LOGGED_ONCE: std::sync::Once = std::sync::Once::new();
        LOGGED_ONCE.call_once(|| {
            crate::diagnostics::warn_with(
                "rag",
                "cosine_normalized invariant violated: input not unit-length",
                serde_json::json!({
                    "a_len": a.len(),
                    "b_len": b.len(),
                    "note": "results may be misranked until embedder normalization is fixed",
                }),
            );
        });
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Dot product of the query against a raw little-endian f32 BLOB in one
/// pass, no intermediate `Vec<f32>` (perf review M23, 2026-06-09 — the
/// search hot loop runs this once per chunk). Semantics mirror
/// `cosine_normalized` for normalized inputs: length mismatch → 0, zero
/// vector → 0, and the unit-length invariant gets the same once-per-process
/// breadcrumb instead of a per-call log.
fn score_blob(q: &[f32], blob: &[u8]) -> f32 {
    if blob.len() != q.len() * 4 || q.is_empty() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut sq = 0f32;
    for (x, c) in q.iter().zip(blob.chunks_exact(4)) {
        let y = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        dot += x * y;
        sq += y * y;
    }
    if sq == 0.0 {
        return 0.0; // cosine(x, 0) = 0 — matches cosine_normalized
    }
    if (sq - 1.0).abs() >= 1e-3 {
        static LOGGED_ONCE: std::sync::Once = std::sync::Once::new();
        LOGGED_ONCE.call_once(|| {
            crate::diagnostics::warn_with(
                "rag",
                "score_blob invariant violated: stored embedding not unit-length",
                serde_json::json!({
                    "note": "results may be misranked until embedder normalization is fixed",
                }),
            );
        });
    }
    dot
}

/// Backwards-compatible alias. Kept so existing callers don't need an
/// atomic rename across the crate; new code should use the explicit name.
#[inline]
#[cfg(test)]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    cosine_normalized(a, b)
}

#[inline]
#[cfg(test)]
fn is_unit_length(v: &[f32]) -> bool {
    if v.is_empty() {
        return true;
    }
    let sq: f32 = v.iter().map(|x| x * x).sum();
    (sq - 1.0).abs() < 1e-3
}

#[cfg(test)]
use crate::util::blob_to_vec;
use crate::util::vec_to_blob;

/* ─────────────────────────── Validation ─────────────────────────────── */

fn validate_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        anyhow::bail!("corpus name length must be 1..=128");
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        anyhow::bail!("corpus name may only contain [A-Za-z0-9._-]");
    }
    Ok(())
}

fn is_text_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .is_some_and(|ext| TEXT_EXTS.iter().any(|e| *e == ext))
}

/* ─────────────────────────── Folder walk ────────────────────────────── */

fn walk_files(root: &Path, glob_matcher: Option<&globset::GlobMatcher>, out: &mut Vec<PathBuf>) {
    // Iterative DFS — avoids unbounded recursion on pathological symlinks.
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                crate::diagnostics::info(
                    "rag-ingest",
                    &format!("read_dir failed on {}: {}", dir.display(), e),
                );
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name_s = name.to_string_lossy();
            // Skip hidden dotfiles at any level (except top-level which has
            // already been opened).
            // Skip ALL hidden entries (dirs AND files), not just hidden dirs.
            // Hidden files are far more likely to be secret-bearing config
            // (.npmrc / .netrc / .pgpass / .dockercfg) than useful corpus text,
            // and the credential denylist below only name-matches `.env*` /
            // `credentials*`, so nested hidden secrets would otherwise be
            // ingested and become retrievable via rag_search.
            if name_s.starts_with('.') && path != root {
                continue;
            }
            // Skip blacklisted directory names.
            if SKIP_DIRS.iter().any(|d| *d == name_s.as_ref()) {
                continue;
            }
            let ty = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ty.is_symlink() {
                // Skip symlinks entirely — prevents loops + escape outside root.
                continue;
            }
            if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() {
                if !is_text_ext(&path) {
                    continue;
                }
                if let Some(g) = glob_matcher {
                    if !g.is_match(&path) {
                        continue;
                    }
                }
                out.push(path);
            }
        }
    }
}

/* ─────────────────────────── Public API ─────────────────────────────── */

/// Cross-file embed batching (inference perf review N1, 2026-06-11): a code
/// repo is mostly files with 1-5 chunks; per-file embed_batch calls meant one
/// HTTP round-trip per file. Files buffer here and flush in ~1k-chunk waves —
/// embed_batch splits into 64-chunk HTTP batches internally, so a flush is a
/// handful of fully-packed requests.
struct PendingFile {
    rel: String,
    mtime_ms: i64,
    size: i64,
    chunks: Vec<(usize, usize, String)>,
}
const FLUSH_CHUNKS: usize = 1024;

/// Embed + insert every buffered file: ONE batched embed call over all
/// pending chunks, then per-file transactions (rows + fingerprint) so a
/// failure mid-flush still leaves whole-file units committed.
///
/// WS3: the embedding call (`embed_batch`, potentially a network round-trip to
/// Ollama) runs BEFORE any write lock is taken; only the per-file insert
/// transactions go through the single-writer gate, so a slow embed never stalls
/// other writers. `conn` is no longer needed (each tx now comes from the gate),
/// but is retained as a no-op param to keep the call sites unchanged.
fn flush_pending(
    _conn: &mut r2d2::PooledConnection<crate::history::SqliteManager>,
    corpus_id: i64,
    chosen: &crate::embedder::Embedder,
    pending: &mut Vec<PendingFile>,
    pending_chunk_count: &mut usize,
    chunks_created: &mut usize,
    files_indexed: &mut usize,
) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let texts: Vec<&str> = pending
        .iter()
        .flat_map(|f| f.chunks.iter().map(|c| c.2.as_str()))
        .collect();
    let embs = chosen
        .embed_batch(&texts)
        .with_context(|| format!("embedding failed via {}", chosen.id()))?;
    let mut ei = 0usize;
    for f in pending.iter() {
        // WS3: single-writer gate, one tx per file (rows + fingerprint).
        let inserted = crate::history::with_write(|tx| {
            let mut count = 0usize;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?;
                for (start, end, chunk) in &f.chunks {
                    let blob = vec_to_blob(&embs[ei]);
                    stmt.execute(params![
                        corpus_id,
                        f.rel,
                        *start as i64,
                        *end as i64,
                        chunk,
                        &blob,
                    ])?;
                    // Keep the vec0 derived index in lockstep with the BLOB
                    // source in the SAME tx so they never diverge. Best-effort:
                    // a vec0-less build (or a transient dim hiccup) leaves the
                    // BLOB intact and search falls back to the linear path.
                    let chunk_id = tx.last_insert_rowid();
                    crate::history::vec_insert_rag_chunk(tx, chunk_id, &embs[ei], &blob);
                    // Mirror the chunk text into the sparse (FTS5) index in the
                    // SAME tx (W5-RAGCORE). Best-effort: a failure leaves the
                    // BLOB/text authoritative and hybrid search falls back to
                    // dense-only / a later rebuild.
                    fts_insert_chunk(tx, chunk_id, chunk);
                    ei += 1;
                    count += 1;
                }
            }
            tx.execute(
                "INSERT INTO rag_files (corpus_id, path, mtime_ms, size) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(corpus_id, path) DO UPDATE SET
                   mtime_ms = excluded.mtime_ms, size = excluded.size",
                params![corpus_id, f.rel, f.mtime_ms, f.size],
            )?;
            Ok(count)
        })?;
        *chunks_created += inserted;
        *files_indexed += 1;
    }
    pending.clear();
    *pending_chunk_count = 0;
    Ok(())
}

pub fn ingest_folder(opts: IngestOpts) -> Result<IngestReport> {
    validate_name(&opts.name)?;
    // Acquire the per-name ingest mutex for the full ingest run. Two
    // concurrent calls for the same corpus serialize here; calls for
    // different corpora proceed in parallel. Lock spans the whole
    // function so the wipe + per-file inserts can't interleave with
    // another invocation's wipe.
    let ingest_lock = ingest_lock_for(&opts.name);
    let _guard = ingest_lock.lock();
    let root = PathBuf::from(&opts.root);
    if !root.is_dir() {
        anyhow::bail!("root '{}' is not a directory", opts.root);
    }
    let root_canon = std::fs::canonicalize(&root)
        .with_context(|| format!("canonicalize root '{}'", opts.root))?;

    let glob_matcher = match opts.glob.as_deref() {
        None | Some("") => None,
        Some(g) => Some(
            globset::Glob::new(g)
                .with_context(|| format!("invalid glob '{g}'"))?
                .compile_matcher(),
        ),
    };

    let started = std::time::Instant::now();
    let mut files: Vec<PathBuf> = Vec::new();
    walk_files(&root_canon, glob_matcher.as_ref(), &mut files);
    let files_seen = files.len();

    // Audit M-R4 (2026-05-28): upsert + lookup ran outside a transaction.
    //
    // MED (2026-05-29): the original flow ALSO deleted the old chunks here,
    // up front, before inserting the new ones. A crash, cancel, or
    // MAX_CHUNKS break between that delete and completion left the corpus
    // present but empty/partial with a stale `chunk_count` — an interrupted
    // re-ingest was net DATA LOSS, not a no-op. Reworked to insert-before-
    // delete with an id watermark: the new chunks land alongside the old
    // ones (both visible transiently), then a single final transaction
    // deletes everything at or below the watermark and updates the count —
    // an atomic old→new swap. If the ingest is interrupted before that final
    // tx, the OLD corpus is still fully intact; the orphaned new chunks are
    // reclaimed by the next successful ingest's watermark.
    // Probe the best available embedder. The FINAL choice is resolved inside
    // the tx below once we know the corpus's stored embedder (post-bump
    // review 2026-06-11): a re-ingest must NOT silently downgrade an existing
    // Ollama (768-dim) corpus to the inferior hashed (512-dim) space just
    // because a 2s probe timed out on a busy daemon. We stick with the
    // corpus's existing learned embedder unless it's genuinely gone.
    let detected = crate::embedder::Embedder::detect();

    let now = now_unix();
    // WS3: single-writer gate for the corpus-setup transaction.
    let (corpus_id, watermark, force_reembed, chosen): (i64, i64, bool, crate::embedder::Embedder) =
        crate::history::with_write(|tx| {
            tx.execute(
                "INSERT INTO rag_corpora (name, root_path, chunk_count, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, updated_at = ?3",
                params![&opts.name, root_canon.to_string_lossy(), now],
            )?;
            let id: i64 = tx.query_row(
                "SELECT id FROM rag_corpora WHERE name = ?1",
                params![&opts.name],
                |r| r.get(0),
            )?;
            // High-water mark BEFORE any new insert. rag_chunks.id is AUTOINCREMENT
            // (monotonic for the table), so every chunk inserted from here on gets
            // an id strictly greater than this — the discriminator for the final
            // swap. Global MAX is intentional (not per-corpus): it's a lower bound
            // that holds even if a concurrent ingest of another corpus interleaves.
            let wm: i64 = tx.query_row("SELECT COALESCE(MAX(id), 0) FROM rag_chunks", [], |r| {
                r.get(0)
            })?;
            let stored: String = tx
                .query_row(
                    "SELECT embedder FROM rag_corpora WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| crate::embedder::HASHED_ID.to_string());
            // Sticky embedder: if this corpus was built with the LEARNED embedder
            // (Ollama) but the probe currently reads Hashed (daemon busy/slow),
            // keep the learned one — embed_batch will succeed on a transient blip
            // or fail loudly if the daemon is truly down, instead of silently
            // re-embedding a good corpus into the weaker hashed space.
            let chosen = if stored == crate::embedder::OLLAMA_MODEL
                && detected == crate::embedder::Embedder::Hashed
            {
                crate::embedder::Embedder::Ollama
            } else {
                detected.clone()
            };
            let force = stored != chosen.id();
            if force {
                // Stale fingerprints would let the copy-forward resurrect vectors
                // from the old embedding space.
                tx.execute("DELETE FROM rag_files WHERE corpus_id = ?1", params![id])?;
                // The new embedder produces a different-dim vector space. Drop the
                // shared vec0 index so the lazy-create in flush_pending rebuilds it
                // at the new dim; a post-swap backfill recovers any other corpora
                // whose BLOBs already match the new dim (BLOB = source of truth).
                crate::history::vec_drop_table(tx, crate::history::VEC_RAG_CHUNKS);
                crate::diagnostics::info(
                    "rag-ingest",
                    &format!(
                        "embedder changed {stored} -> {} — full re-embed",
                        chosen.id()
                    ),
                );
            }
            Ok((id, wm, force, chosen))
        })?;

    // Embedder switch just dropped the shared vec0 table (it lazily recreates at
    // the new model's dim in flush_pending). Drop the memoized dim so the next
    // search re-probes the schema instead of trusting the old model's dim —
    // mirrors `memory::invalidate_cache`'s reset after its vec0 drop. Only the
    // `force_reembed` branch dropped the table; a non-force re-ingest leaves the
    // dim unchanged.
    if force_reembed {
        reset_vec_rag_dim_memo();
    }

    let mut files_indexed = 0usize;
    let mut chunks_created = 0usize;
    let mut total_bytes: u64 = 0;

    let mut pending: Vec<PendingFile> = Vec::new();
    let mut pending_chunk_count: usize = 0;

    // Batch insert per file to keep transactions small.
    let mut conn = get_db()?;
    for file in &files {
        if chunks_created >= MAX_CHUNKS_PER_INGEST {
            break;
        }
        // SEC-MED F2 (2026-05-30): a workspace rooted at $HOME still contains
        // ~/.ssh, ~/.aws, .env files, etc. Skip protected paths so credentials
        // never enter the corpus (and can't be exfiltrated via rag_search).
        if crate::agent::is_protected_read_path(file) {
            continue;
        }
        let meta = match std::fs::metadata(file) {
            Ok(m) => m,
            Err(e) => {
                crate::diagnostics::warn_with(
                    "rag-ingest",
                    &format!("stat failed, skipping {}", file.display()),
                    serde_json::json!({ "path": file.display().to_string(), "error": e.to_string() }),
                );
                continue;
            }
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let rel = file
            .strip_prefix(&root_canon)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned();

        // Perf review M26 (2026-06-09): a re-ingest used to re-read,
        // re-chunk and re-embed every file even when nothing changed. If the
        // file's (mtime, size) matches the previous ingest, carry the prior
        // generation's rows forward with a pure SQL copy — the fresh
        // AUTOINCREMENT ids land above the watermark, so the final swap
        // keeps them. No read, no chunking, no embedding. mtime_ms == 0
        // (unreadable mtime) always takes the full path.
        let mtime_ms: i64 = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        if mtime_ms > 0 && !force_reembed {
            let unchanged = conn
                .query_row(
                    "SELECT 1 FROM rag_files
                     WHERE corpus_id = ?1 AND path = ?2 AND mtime_ms = ?3 AND size = ?4",
                    params![corpus_id, rel, mtime_ms, size],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if unchanged {
                let remaining = (MAX_CHUNKS_PER_INGEST - chunks_created) as i64;
                // WS3: single-writer gate for the copy-forward insert.
                let copied = crate::history::with_write(|tx| {
                    let n = tx.execute(
                        "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                         SELECT corpus_id, path, start_byte, end_byte, text, embedding
                         FROM rag_chunks
                         WHERE corpus_id = ?1 AND path = ?2 AND id <= ?3
                         ORDER BY id LIMIT ?4",
                        params![corpus_id, rel, watermark, remaining],
                    )?;
                    // Mirror the copied (above-watermark) chunks into the vec0
                    // index in the SAME tx so the derived index carries forward
                    // with the BLOB source. Best-effort + dim-guarded inside.
                    crate::history::vec_backfill_rag_above(tx, corpus_id, &rel, watermark);
                    // Same lockstep mirror into the sparse (FTS5) index for the
                    // copy-forward path (W5-RAGCORE). Best-effort.
                    fts_backfill_above(tx, corpus_id, &rel, watermark);
                    Ok(n)
                })?;
                if copied > 0 {
                    chunks_created += copied;
                    files_indexed += 1;
                    total_bytes += size as u64;
                    continue;
                }
                // No prior rows to copy (all chunks were skipped last time,
                // or the cap cut this file) — fall through to the full path.
            }
        }

        let is_pdf = file
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        let text = if is_pdf {
            // pdf-extract is already a dependency (the read_pdf agent tool).
            // It is known to panic on exotic PDFs — contain that to a skip.
            let path = file.clone();
            match std::panic::catch_unwind(move || pdf_extract::extract_text(&path)) {
                Ok(Ok(t)) => {
                    // Cap extracted text at the same budget as source files so
                    // one giant PDF can't dominate the chunk cap.
                    let mut t = t;
                    if t.len() > MAX_FILE_BYTES as usize {
                        let mut cut = MAX_FILE_BYTES as usize;
                        while !t.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        t.truncate(cut);
                    }
                    t
                }
                Ok(Err(e)) => {
                    crate::diagnostics::info(
                        "rag-ingest",
                        &format!("skipping unreadable pdf {} ({})", file.display(), e),
                    );
                    continue;
                }
                Err(_) => {
                    crate::diagnostics::warn_with(
                        "rag-ingest",
                        "pdf extractor panicked — file skipped",
                        serde_json::json!({ "path": file.display().to_string() }),
                    );
                    continue;
                }
            }
        } else {
            match std::fs::read_to_string(file) {
                Ok(t) => t,
                Err(e) => {
                    crate::diagnostics::info(
                        "rag-ingest",
                        &format!("skipping non-utf8/unreadable {} ({})", file.display(), e),
                    );
                    continue;
                }
            }
        };
        total_bytes += text.len() as u64;
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            continue;
        }
        // Defense-in-depth filter FIRST (chunks with prompt-injection markers
        // never enter the corpus — search-time scan_and_wrap remains the
        // second layer); survivors join the cross-file pending buffer.
        let mut kept: Vec<(usize, usize, String)> = Vec::with_capacity(chunks.len());
        for c in chunks {
            let (_wrapped, hits) = crate::agent::injection_scan::scan_and_wrap(&c.2);
            if hits > 0 {
                crate::diagnostics::warn_with(
                    "rag-ingest",
                    "skipped chunk with injection markers",
                    serde_json::json!({ "path": rel, "start": c.0, "end": c.1, "hits": hits }),
                );
                continue;
            }
            kept.push(c);
        }
        let room = MAX_CHUNKS_PER_INGEST.saturating_sub(chunks_created + pending_chunk_count);
        if kept.len() > room {
            kept.truncate(room);
        }
        if kept.is_empty() {
            continue;
        }
        pending_chunk_count += kept.len();
        pending.push(PendingFile {
            rel,
            mtime_ms,
            size,
            chunks: kept,
        });
        if pending_chunk_count >= FLUSH_CHUNKS {
            flush_pending(
                &mut conn,
                corpus_id,
                &chosen,
                &mut pending,
                &mut pending_chunk_count,
                &mut chunks_created,
                &mut files_indexed,
            )?;
        }
    }
    // Embed + insert whatever's left in the buffer.
    flush_pending(
        &mut conn,
        corpus_id,
        &chosen,
        &mut pending,
        &mut pending_chunk_count,
        &mut chunks_created,
        &mut files_indexed,
    )?;

    // Atomic swap: drop the old generation (everything at/below the
    // watermark) and publish the new count in ONE transaction. Until this
    // commits, search still sees the old corpus; after, it sees only the new
    // chunks. An interruption before this point leaves the old corpus whole.
    // WS3: single-writer gate.
    crate::history::with_write(|tx| {
        // vec0 has no FK, so the derived index rows for the old generation must
        // be deleted in the SAME tx as the BLOB rows they mirror — before the
        // rag_chunks delete, while the ids are still resolvable by join.
        crate::history::vec_delete_rag_old_generation(tx, corpus_id, watermark);
        // Same pre-delete for the sparse (FTS5) index: external-content FTS5
        // needs the chunk text (still present) to remove an entry cleanly, so
        // this MUST run before the rag_chunks delete too (W5-RAGCORE).
        fts_delete_old_generation(tx, corpus_id, watermark);
        tx.execute(
            "DELETE FROM rag_chunks WHERE corpus_id = ?1 AND id <= ?2",
            params![corpus_id, watermark],
        )?;
        tx.execute(
            "UPDATE rag_corpora SET chunk_count = ?1, updated_at = ?2, embedder = ?4 WHERE id = ?3",
            params![chunks_created as i64, now_unix(), corpus_id, chosen.id()],
        )?;
        // Drop fingerprints for files that no longer produced chunks this
        // generation (deleted/renamed/now-skipped) so a future re-appearance
        // can't false-positive as "unchanged".
        tx.execute(
            "DELETE FROM rag_files WHERE corpus_id = ?1 AND path NOT IN (
                SELECT DISTINCT path FROM rag_chunks WHERE corpus_id = ?1
             )",
            params![corpus_id],
        )?;
        // On an embedder switch the vec0 table was dropped + lazily rebuilt at
        // the new dim by this generation's writes. Re-backfill ALL chunks whose
        // BLOB matches the (now new) table dim so other corpora already in the
        // new space rejoin the index (BLOB stays the source of truth either way).
        if force_reembed {
            crate::history::vec_backfill_rag_all_matching_dim(tx);
        }
        Ok(())
    })?;

    Ok(IngestReport {
        corpus_id,
        files_seen,
        files_indexed,
        chunks_created,
        total_bytes,
        duration_ms: started.elapsed().as_millis(),
    })
}

/// Linear top-k cosine scan over a corpus's chunk BLOBs — the verbatim
/// pre-vec0 ranking, preserved as the fallback (and the parity reference).
///
/// Maturity review H1 (2026-05-27): BinaryHeap<Reverse<...>> of capacity k
/// gives O(N log k) instead of a full sort. Perf review M23 (2026-06-09): the
/// scan scores straight off the borrowed BLOB bytes inside the row callback
/// (zero per-row heap allocation). Returns `(score, id)` pairs, score DESC,
/// with `score > 0` only — matching the vec0 path's filter.
fn search_linear(
    conn: &rusqlite::Connection,
    corpus_id: i64,
    q_emb: &[f32],
    k: usize,
) -> Result<Vec<(f32, i64)>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    // OrderedF32 wrapper — f32 isn't Ord because of NaN, but cosine over
    // finite inputs never produces NaN (caller already enforces non-empty
    // query string, and `embed` returns finite values).
    #[derive(Clone)]
    struct OrderedF32(f32);
    impl PartialEq for OrderedF32 {
        fn eq(&self, other: &Self) -> bool {
            self.0.to_bits() == other.0.to_bits()
        }
    }
    impl Eq for OrderedF32 {}
    impl PartialOrd for OrderedF32 {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(other))
        }
    }
    impl Ord for OrderedF32 {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            self.0
                .partial_cmp(&other.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    }
    let mut stmt = conn.prepare("SELECT id, embedding FROM rag_chunks WHERE corpus_id = ?1")?;
    let mut heap: BinaryHeap<Reverse<(OrderedF32, i64)>> = BinaryHeap::with_capacity(k + 1);
    let rows = stmt.query_map(params![corpus_id], |r| {
        let id: i64 = r.get(0)?;
        // Borrow the BLOB in place — no Vec<u8>/Vec<f32> per row.
        let score = match r.get_ref(1)?.as_blob() {
            Ok(b) => score_blob(q_emb, b),
            Err(_) => 0.0,
        };
        Ok((id, score))
    })?;
    for row in rows {
        let (id, score) = row?;
        if score <= 0.0 {
            continue;
        }
        heap.push(Reverse((OrderedF32(score), id)));
        // Trim back to k by dropping the smallest. `pop` on a min-heap
        // is O(log k).
        if heap.len() > k {
            heap.pop();
        }
    }
    drop(stmt);
    // `into_sorted_vec()` on this min-heap of `Reverse((score,id))` yields
    // elements ascending by the heap order = DESCENDING by score (highest
    // first), which is exactly the order we want — no extra reverse. (The
    // pre-vec0 code reversed here, which actually produced worst-first; the
    // returned RagHit set was unaffected since downstream sorts by score, but
    // this also brings the linear path into exact rank parity with the vec0
    // KNN path, which orders by ascending distance = descending score.)
    let winners: Vec<(f32, i64)> = heap
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((s, id))| (s.0, id))
        .collect();
    Ok(winners)
}

/// vec0 ANN top-k for a corpus. The corpus filter is POST-KNN (vec0 KNN is
/// global over the shared table), so we over-fetch `k * 8` (clamped) neighbours,
/// JOIN to `rag_chunks` to keep only this corpus's rows, map cosine distance to
/// score (`1 - distance`, since the table is `distance_metric=cosine` over
/// L2-normalized vectors), drop non-positive scores, and keep the top k. Caller
/// only invokes this when `vec0_usable_for` confirmed the dim matches.
fn search_vec_rag(
    conn: &rusqlite::Connection,
    corpus_id: i64,
    q_emb: &[f32],
    k: usize,
) -> Result<Vec<(f32, i64)>> {
    // Over-fetch because the corpus filter prunes the GLOBAL KNN result (vec0
    // ranks across the shared table, then the JOIN keeps only this corpus).
    // Clamp so a huge k can't blow the candidate set up unboundedly. vec0
    // forbids combining `k = ?` with `LIMIT`, so `k` IS the candidate count and
    // the final top-k trim happens in Rust below.
    let overfetch = (k.saturating_mul(8)).clamp(k, 512) as i64;
    let q_blob = vec_to_blob(q_emb);
    let mut stmt = conn.prepare(&format!(
        "SELECT v.chunk_id, v.distance
         FROM {table} v
         JOIN rag_chunks c ON c.id = v.chunk_id
         WHERE v.embedding MATCH ?1 AND k = ?2 AND c.corpus_id = ?3
         ORDER BY v.distance",
        table = crate::history::VEC_RAG_CHUNKS
    ))?;
    let rows = stmt.query_map(params![q_blob, overfetch, corpus_id], |r| {
        let id: i64 = r.get(0)?;
        let distance: f64 = r.get(1)?;
        Ok((id, distance))
    })?;
    let mut winners: Vec<(f32, i64)> = Vec::with_capacity(k);
    for row in rows {
        let (id, distance) = row?;
        let score = 1.0f32 - distance as f32;
        if score <= 0.0 {
            continue;
        }
        winners.push((score, id));
        if winners.len() >= k {
            break;
        }
    }
    Ok(winners)
}

/// Sparse BM25 top-k for a corpus over the FTS5 index. Returns `(id, rank)`
/// pairs in ascending bm25 order (best first), where `rank` is the 0-based
/// position used by RRF (NOT the raw bm25 score — RRF is rank-only by design, so
/// the dense cosine and sparse bm25 magnitudes never need to be commensurable).
///
/// The raw user query is wrapped per-token in double quotes so FTS5 operators
/// (AND/OR/NEAR/^/*) in user text can't inject query syntax errors — every
/// token is a plain phrase term (same neutralization as `search_messages_fts`).
/// Returns an empty Vec (never an error) when the query has no usable tokens or
/// the FTS table is unavailable — the caller then proceeds dense-only.
fn search_fts(
    conn: &rusqlite::Connection,
    corpus_id: i64,
    query: &str,
    k: usize,
) -> Vec<(i64, usize)> {
    let safe: Vec<String> = query
        .split_whitespace()
        .take(32)
        .filter_map(|t| {
            let cleaned = t.replace('"', "");
            if cleaned.is_empty() {
                None
            } else {
                Some(format!("\"{cleaned}\""))
            }
        })
        .collect();
    if safe.is_empty() {
        return Vec::new();
    }
    // OR the terms so a query matches chunks containing ANY token (recall-
    // oriented; RRF + the dense leg handle precision). bm25() returns smaller =
    // better, so ORDER BY bm25 ASC is best-first.
    let fts_query = safe.join(" OR ");
    let sql = format!(
        "SELECT f.rowid
         FROM {RAG_FTS} f
         JOIN rag_chunks c ON c.id = f.rowid
         WHERE {RAG_FTS} MATCH ?1 AND c.corpus_id = ?2
         ORDER BY bm25({RAG_FTS})
         LIMIT ?3"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![fts_query, corpus_id, k as i64], |r| {
        r.get::<_, i64>(0)
    });
    let rows = match rows {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::with_capacity(k);
    for (rank, row) in rows.enumerate() {
        match row {
            Ok(id) => out.push((id, rank)),
            Err(_) => break,
        }
    }
    out
}

/// Reciprocal Rank Fusion of a dense ranking and a sparse ranking.
///
/// RRF score for a doc = Σ_lists 1/(RRF_K + rank_in_list), summed across every
/// ranked list the doc appears in (rank is 0-based here). It needs no score
/// normalization — it fuses purely on RANK, which is exactly why it's robust to
/// the dense cosine and sparse bm25 living on incomparable scales. `RRF_K`
/// (60, the canonical default from the original RRF paper) damps the influence
/// of very-top ranks just enough that a doc strong in BOTH lists outranks one
/// that merely tops a single list.
///
/// `dense` is `(score, id)` best-first (the existing winner shape); `sparse` is
/// `(id, rank)` best-first. Returns `(fused_score, id)` sorted DESC, top `k`.
/// Ties broken by id DESC for determinism.
fn rrf_fuse(dense: &[(f32, i64)], sparse: &[(i64, usize)], k: usize) -> Vec<(f32, i64)> {
    const RRF_K: f32 = 60.0;
    // `HashMap` is already imported at module scope.
    let mut acc: HashMap<i64, f32> = HashMap::with_capacity(dense.len() + sparse.len());
    for (rank, (_score, id)) in dense.iter().enumerate() {
        *acc.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + rank as f32);
    }
    for (id, rank) in sparse.iter() {
        *acc.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + *rank as f32);
    }
    let mut fused: Vec<(f32, i64)> = acc.into_iter().map(|(id, s)| (s, id)).collect();
    fused.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.cmp(&a.1))
    });
    fused.truncate(k);
    fused
}

pub fn search(corpus_name: &str, query: &str, top_k: u32) -> Result<Vec<RagHit>> {
    validate_name(corpus_name)?;
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.len() > 4096 {
        anyhow::bail!("query exceeds 4096 chars");
    }
    let k = top_k.clamp(1, 50) as usize;

    let conn = get_db()?;
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, embedder FROM rag_corpora WHERE name = ?1",
            params![corpus_name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (corpus_id, embedder_id) = match row {
        Some(v) => v,
        None => anyhow::bail!("corpus '{}' not found", corpus_name),
    };
    // The query MUST be embedded in the same vector space as the corpus —
    // cross-space scoring silently returns garbage ranks.
    let q_emb = crate::embedder::Embedder::from_id(&embedder_id)
        .embed_one(trimmed)
        .with_context(|| {
            format!(
                "corpus '{corpus_name}' uses '{embedder_id}' embeddings but that embedder is unavailable — start Ollama (or re-ingest the corpus) and retry"
            )
        })?;

    // Pass 1a: DENSE ranking → top `dense_k` `(score, id)` (score DESC). Prefer
    // the vec0 ANN index when usable for this query's dim; else fall through to
    // the preserved linear scan. Over-fetch beyond `k` so RRF has enough dense
    // candidates to fuse with the sparse leg (a doc that's #k+3 dense but #1
    // sparse should still surface). Bounded so a huge corpus can't blow up.
    let dense_k = (k.saturating_mul(4)).clamp(k, 100);
    let dense: Vec<(f32, i64)> = if vec0_rag_usable(&conn, q_emb.len()) {
        match search_vec_rag(&conn, corpus_id, &q_emb, dense_k) {
            // Recall guard (review 2026-06-14): all corpora share ONE global
            // vec0 table, so `search_vec_rag` resolves the KNN GLOBALLY first
            // (bounded by the clamped 8x over-fetch) and only THEN filters to
            // this corpus via the JOIN. When a larger sibling corpus owns the
            // globally-nearest neighbours, a query against a small corpus can
            // come back with FEWER than dense_k hits even though the corpus holds
            // good matches further down the global ranking — silent recall
            // loss vs the linear path, which scans ONLY this corpus. So if the
            // vec0 result is short, fall back to the corpus-scoped linear scan
            // (its true top-k). A corpus genuinely smaller than dense_k still
            // returns the same set both ways, so the fallback is free in that case.
            Ok(w) if w.len() >= dense_k => w,
            Ok(_) => search_linear(&conn, corpus_id, &q_emb, dense_k)?,
            Err(e) => {
                // vec0 errored at query time (corruption, transient) — never
                // hard-fail: log once and fall back to the linear scan.
                crate::diagnostics::warn_with(
                    "rag",
                    "vec0 KNN query failed — falling back to linear scan",
                    serde_json::json!({ "error": e.to_string() }),
                );
                search_linear(&conn, corpus_id, &q_emb, dense_k)?
            }
        }
    } else {
        search_linear(&conn, corpus_id, &q_emb, dense_k)?
    };

    // Pass 1b: SPARSE (BM25) ranking, then FUSE via RRF. The sparse leg fixes
    // exact-identifier / error-code misses that pure dense retrieval drops. It
    // is FORWARD-ONLY: only consulted when the FTS index is available + non-
    // empty for this DB. `ensure_fts_populated` lazily builds + backfills it on
    // first use against a legacy corpus; if FTS5 is unavailable or the index is
    // empty (a brand-new corpus that has never been (re)indexed since this
    // feature shipped) we keep the dense-only ranking verbatim — preserving the
    // exact pre-hybrid behavior and the linear-fallback parity tests.
    let winners: Vec<(f32, i64)> = if ensure_fts_populated(&conn) {
        let sparse = search_fts(&conn, corpus_id, trimmed, dense_k);
        if sparse.is_empty() {
            // No keyword matches (or no usable query tokens) → dense is the
            // ranking; just trim to k so the contract is unchanged.
            let mut w = dense;
            w.truncate(k);
            w
        } else {
            rrf_fuse(&dense, &sparse, k)
        }
    } else {
        let mut w = dense;
        w.truncate(k);
        w
    };

    // Pass 2: fetch the winners' payloads (k ≤ 50, so the IN list is tiny).
    let mut scored: Vec<(f32, String, i64, i64, String)> = Vec::with_capacity(winners.len());
    if !winners.is_empty() {
        let placeholders = vec!["?"; winners.len()].join(",");
        let mut fetch = conn.prepare(&format!(
            "SELECT id, path, start_byte, end_byte, text FROM rag_chunks WHERE id IN ({placeholders})"
        ))?;
        let id_params = rusqlite::params_from_iter(winners.iter().map(|(_, id)| *id));
        let mut by_id = std::collections::HashMap::with_capacity(winners.len());
        let fetched = fetch.query_map(id_params, |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ),
            ))
        })?;
        for row in fetched {
            let (id, payload) = row?;
            by_id.insert(id, payload);
        }
        for (score, id) in winners {
            if let Some((path, s, e, text)) = by_id.remove(&id) {
                scored.push((score, path, s, e, text));
            }
        }
    }
    // Sec re-review H-NEW-3: RAG hits flow back into the agent loop as
    // primary input. Until now they bypassed the injection scanner that
    // wraps every other external-content tool. Wrap the snippet so any
    // attacker-shipped "ignore previous instructions" inside an indexed
    // codebase / docs / chat-export carries the DATA-only marker.
    Ok(scored
        .into_iter()
        .map(|(score, path, s, e, text)| {
            let snippet = snippet_of(&text);
            let (wrapped, _n) = crate::agent::injection_scan::scan_and_wrap(&snippet);
            RagHit {
                path,
                snippet: wrapped,
                score,
                start_byte: s,
                end_byte: e,
            }
        })
        .collect())
}

fn snippet_of(text: &str) -> String {
    const MAX: usize = 400;
    if text.len() <= MAX {
        return text.to_string();
    }
    // Cut on a char boundary near MAX.
    let mut cut = MAX;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
}

pub fn list_corpora() -> Result<Vec<CorpusInfo>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, root_path, chunk_count, created_at, updated_at
         FROM rag_corpora ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CorpusInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                chunk_count: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                // Staleness is NOT computed here — see the `stale` field doc.
                // Callers that need it use `corpus_stale` per corpus on demand.
                stale: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether a corpus's source folder has drifted from what was last ingested.
///
/// W2-RAG (2026-06-15): re-walks the corpus `root_path` (same skip/ext/glob
/// rules as ingest, minus the glob — staleness is a coarse "anything changed?"
/// signal) and compares the live `(mtime_ms, size)` of each file against the
/// `rag_files` fingerprints recorded by the last ingest. A corpus is STALE if
/// any tracked file changed/disappeared, or a new ingestable file appeared.
/// Pure read + `stat` (no embedding, no DB writes), so it is cheap enough to
/// poll. A missing root, or a corpus that produced zero fingerprints, is
/// reported as NOT stale (nothing actionable / can't compare).
pub fn corpus_stale(name: &str) -> Result<bool> {
    validate_name(name)?;
    let conn = get_db()?;
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, root_path FROM rag_corpora WHERE name = ?1",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (corpus_id, root_path) = match row {
        Some(v) => v,
        None => return Ok(false),
    };
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        // The folder is gone — there's nothing to re-ingest against, so don't
        // flag it as stale (a delete is a separate, explicit user action).
        return Ok(false);
    }

    // Last-ingest fingerprints keyed by the same relative path ingest stores.
    let mut fingerprints: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT path, mtime_ms, size FROM rag_files WHERE corpus_id = ?1")?;
        let rows = stmt.query_map(params![corpus_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
            ))
        })?;
        for row in rows {
            let (path, fp) = row?;
            fingerprints.insert(path, fp);
        }
    }
    // No fingerprints recorded (empty/older corpus) — can't meaningfully diff.
    if fingerprints.is_empty() {
        return Ok(false);
    }

    let root_canon = std::fs::canonicalize(&root).unwrap_or(root);
    let mut files: Vec<PathBuf> = Vec::new();
    walk_files(&root_canon, None, &mut files);

    let mut seen = 0usize;
    for file in &files {
        if crate::agent::is_protected_read_path(file) {
            continue;
        }
        let meta = match std::fs::metadata(file) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let rel = file
            .strip_prefix(&root_canon)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned();
        let mtime_ms: i64 = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        match fingerprints.get(&rel) {
            // New ingestable file the last ingest never saw → stale.
            None => return Ok(true),
            // Same path but a different (mtime, size) → stale.
            Some(&(fmt, fsz)) if fmt != mtime_ms || fsz != size => return Ok(true),
            Some(_) => {}
        }
        seen += 1;
    }
    // A tracked file that is no longer present on disk → stale.
    if seen < fingerprints.len() {
        return Ok(true);
    }
    Ok(false)
}

/// Rebuild the sparse (FTS5) hybrid index for one corpus from its already-stored
/// `rag_chunks` text — no file walk, no re-embed (W5-RAGCORE). This is the cheap
/// "give this (legacy) corpus the hybrid keyword leg" path the RagPanel exposes
/// per row: it drops the corpus's current FTS rows and re-derives them from the
/// content table, so it is safe to run repeatedly and never duplicates entries.
///
/// FORWARD-ONLY + NON-DESTRUCTIVE to user data: only the DERIVED FTS index is
/// touched; `rag_chunks` (the text + BLOB source of truth), the dense vectors,
/// and the corpus's `embedder` fingerprint are all untouched. For a full re-
/// embed (e.g. after starting Ollama so a hashed corpus upgrades to learned
/// vectors) the caller uses the existing re-ingest path, which re-walks +
/// re-embeds AND repopulates this index in lockstep. Returns the number of
/// chunks (re)indexed into the sparse leg.
pub fn rebuild_hybrid_index(name: &str) -> Result<usize> {
    validate_name(name)?;
    let conn = get_db()?;
    let corpus_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM rag_corpora WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .optional()?;
    let corpus_id = match corpus_id {
        Some(v) => v,
        None => anyhow::bail!("corpus '{}' not found", name),
    };
    // WS3: single-writer gate. Ensure the table exists, drop this corpus's
    // current FTS rows (external-content delete needs the still-present text),
    // then re-insert every chunk's text. All in one tx so a reader never sees a
    // half-rebuilt index for this corpus.
    let n = crate::history::with_write(|tx| {
        ensure_fts_table(tx)?;
        // Remove this corpus's existing entries (idempotent re-run).
        tx.execute(
            &format!(
                "INSERT INTO {RAG_FTS}({RAG_FTS}, rowid, text)
                 SELECT 'delete', id, text FROM rag_chunks WHERE corpus_id = ?1"
            ),
            params![corpus_id],
        )?;
        // Re-derive from the content source.
        let inserted = tx.execute(
            &format!(
                "INSERT INTO {RAG_FTS}(rowid, text)
                 SELECT id, text FROM rag_chunks WHERE corpus_id = ?1"
            ),
            params![corpus_id],
        )?;
        Ok(inserted)
    })?;
    Ok(n)
}

pub fn delete_corpus(name: &str) -> Result<()> {
    validate_name(name)?;
    // WS3: single-writer gate.
    crate::history::with_write(|tx| {
        // Resolve the corpus id so we can drop its vec0 rows in the same tx —
        // the FK cascade reaches rag_chunks but NOT the FK-less vec0 index.
        let corpus_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM rag_corpora WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(cid) = corpus_id {
            crate::history::vec_delete_rag_corpus(tx, cid);
            // Mirror-delete the sparse (FTS5) rows for this corpus before the FK
            // cascade drops rag_chunks (external-content FTS5 needs the text to
            // delete cleanly). Best-effort (W5-RAGCORE).
            fts_delete_corpus(tx, cid);
        }
        tx.execute("DELETE FROM rag_corpora WHERE name = ?1", params![name])?;
        Ok(())
    })
}

/* ─────────────────────────── Tests ──────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunker_handles_edge_cases() {
        // Empty
        assert!(chunk_text("").is_empty());
        // Whitespace-only
        assert!(chunk_text("   \n  \t  ").is_empty());
        // Short — single chunk
        let c = chunk_text("hello world");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].2, "hello world");
        assert_eq!(c[0].0, 0);
        assert_eq!(c[0].1, "hello world".len());

        // Long single-line — multiple overlapping chunks, no panic
        let huge: String = "ab".repeat(2000); // 4000 chars
        let chunks = chunk_text(&huge);
        assert!(
            chunks.len() >= 2,
            "expected multi-chunk for 4000-char input"
        );
        for (s, e, t) in &chunks {
            assert!(t.chars().count() <= MAX_CHUNK_CHARS);
            assert!(e > s);
        }
        // First chunk starts at 0
        assert_eq!(chunks[0].0, 0);
        // Adjacent chunks have overlap (start of next < end of previous)
        for w in chunks.windows(2) {
            assert!(w[1].0 < w[0].1, "chunks must overlap");
        }

        // Multibyte safety — emoji in input
        let s = "α".repeat(MAX_CHUNK_CHARS + 50);
        let chunks = chunk_text(&s);
        assert!(!chunks.is_empty());
        for (_, _, t) in chunks {
            assert!(!t.is_empty());
        }
    }

    /// Structure-aware chunking (W2-RAG, 2026-06-15): the offsets must always
    /// reconstruct the original text verbatim (no bytes dropped/duplicated
    /// outside the intentional sliding-window overlap), every chunk must
    /// respect the cap, and every (start,end) must land on a char boundary so
    /// downstream slicing is UTF-8 safe.
    #[test]
    fn chunk_offsets_are_valid_and_in_bounds() {
        let doc = "# Title\n\nIntro paragraph with some words.\n\n\
                   ## Section\n\nfn do_work() {\n    let x = 1;\n}\n\n\
                   Another paragraph here that says things.\n";
        let chunks = chunk_text(doc);
        assert!(!chunks.is_empty());
        for (s, e, t) in &chunks {
            assert!(e > s, "end must exceed start");
            assert!(*e <= doc.len(), "end within bounds");
            assert!(doc.is_char_boundary(*s), "start on char boundary");
            assert!(doc.is_char_boundary(*e), "end on char boundary");
            // The stored text must equal the slice it claims to cover.
            assert_eq!(t, &doc[*s..*e], "chunk text must match its byte range");
            assert!(t.chars().count() <= MAX_CHUNK_CHARS, "cap respected");
        }
        // Coverage: the union of ranges must span the whole non-trivial doc
        // (first chunk starts at 0, last ends at len).
        assert_eq!(chunks.first().unwrap().0, 0);
        assert_eq!(chunks.last().unwrap().1, doc.len());
    }

    /// A markdown document with several headings should split at heading
    /// boundaries (not blind 512-char windows) when the sections are large
    /// enough to stand alone.
    #[test]
    fn chunk_splits_on_markdown_headings() {
        // Three sections, each body large enough (~300 chars) that two adjacent
        // sections can't pack into one ≤MAX_CHUNK_CHARS chunk — so the heading
        // boundary forces a split rather than a blind 512-char window.
        let body = "x ".repeat(150); // ~300 chars per section body
        let doc = format!("# Alpha\n\n{body}\n\n## Beta\n\n{body}\n\n## Gamma\n\n{body}\n");
        let chunks = chunk_text(&doc);
        // Expect at least three chunks (one per section).
        assert!(
            chunks.len() >= 3,
            "expected per-section chunks, got {}: {:#?}",
            chunks.len(),
            chunks.iter().map(|c| &c.2).collect::<Vec<_>>()
        );
        // The first chunk should head with the first heading (the heading
        // boundary is honoured, not sliced mid-section).
        assert!(chunks[0].2.trim_start().starts_with("# Alpha"));
        // A blind 512-char windower would have put "## Beta" mid-chunk; here it
        // must begin a chunk of its own.
        assert!(
            chunks
                .iter()
                .any(|c| c.2.trim_start().starts_with("## Beta")),
            "## Beta should head its own chunk: {:#?}",
            chunks.iter().map(|c| &c.2).collect::<Vec<_>>()
        );
    }

    /// Tiny segments (a lone heading, a one-line paragraph) get glued onto
    /// neighbours instead of producing near-empty chunks.
    #[test]
    fn chunk_globs_tiny_segments() {
        let doc = "# H\n\nshort\n\nalso short\n\ntiny\n";
        let chunks = chunk_text(doc);
        // Everything is well under MIN_CHUNK_CHARS, so it should coalesce into
        // a single chunk rather than four micro-chunks.
        assert_eq!(
            chunks.len(),
            1,
            "tiny segments should glob: {:#?}",
            chunks.iter().map(|c| &c.2).collect::<Vec<_>>()
        );
    }

    /// An oversized single segment (one giant paragraph with no internal
    /// boundary) must still be sub-split with overlap so the cap holds.
    #[test]
    fn chunk_subsplits_oversized_segment() {
        let para = "word ".repeat(400); // 2000 chars, single paragraph
        let chunks = chunk_text(&para);
        assert!(chunks.len() >= 2, "oversized segment must sub-split");
        for (_, _, t) in &chunks {
            assert!(t.chars().count() <= MAX_CHUNK_CHARS);
        }
        // Sub-split chunks overlap (the original sliding-window contract).
        for w in chunks.windows(2) {
            assert!(w[1].0 < w[0].1, "sub-split chunks must overlap");
        }
    }

    #[test]
    fn cosine_ranking_is_correct() {
        // Identical text → 1.0
        let a = embed("the quick brown fox jumps over the lazy dog");
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-5);

        // Similar (overlapping vocabulary) > unrelated
        let related = embed("a quick brown fox jumped over a lazy hound");
        let unrelated = embed("rusqlite database transaction commit rollback");
        let s_related = cosine(&a, &related);
        let s_unrelated = cosine(&a, &unrelated);
        assert!(
            s_related > s_unrelated,
            "related ({s_related}) should beat unrelated ({s_unrelated})"
        );
        assert!(s_related > 0.2, "related score should be meaningful");

        // Zero vector for empty input → 0 cosine
        let z = embed("");
        assert_eq!(cosine(&z, &a), 0.0);

        // Search ranking end-to-end: top hit beats noise on shared keyword.
        let mut hits: Vec<(f32, &str)> = vec![
            (
                cosine(
                    &embed("hello world greetings"),
                    &embed("hello world greeting"),
                ),
                "match",
            ),
            (
                cosine(
                    &embed("hello world greetings"),
                    &embed("airplane mango piano"),
                ),
                "noise",
            ),
        ];
        hits.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
        assert_eq!(hits[0].1, "match");
    }

    #[test]
    fn embed_is_normalized() {
        let v = embed("some sample text for the embedding");
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "L2 norm should be 1, got {norm}");
        assert_eq!(v.len(), EMBED_DIM);
    }

    #[test]
    fn blob_roundtrip() {
        // Pick numbers that don't trip clippy's approx_constant lint (3.14 ≈ PI,
        // 2.718 ≈ E). Use values that exercise positive/negative/zero/fractional cases.
        let v = vec![0.5f32, -1.25, 0.0, 1.5];
        let blob = vec_to_blob(&v);
        let back = blob_to_vec(&blob);
        assert_eq!(v, back);
    }

    #[test]
    fn validate_name_rules() {
        assert!(validate_name("my-project").is_ok());
        assert!(validate_name("Proj_1.2").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("has spaces").is_err());
        assert!(validate_name("has/slash").is_err());
    }

    /// MED (2026-05-29): re-ingesting an existing corpus must REPLACE its
    /// content atomically — the old chunks gone, the new ones in, the count
    /// reflecting only the new generation. This exercises the insert-before-
    /// delete watermark swap (no data-loss window). Runs against the shared
    /// dev DB like the other DB-touching tests; uses a unique name + temp dir
    /// and cleans up after itself.
    #[test]
    fn reingest_swaps_content_not_appends() {
        let tag = std::process::id();
        let name = format!("__test_reingest_{tag}");
        let dir = std::env::temp_dir().join(format!("rag_reingest_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.txt");
        let opts = || IngestOpts {
            name: name.clone(),
            root: dir.to_string_lossy().into_owned(),
            glob: None,
        };

        // First ingest — a distinctive token only in this generation.
        std::fs::write(
            &file,
            "alphaunique alphaunique alphaunique filler text here",
        )
        .unwrap();
        let r1 = ingest_folder(opts()).expect("first ingest");
        assert!(r1.chunks_created >= 1);
        let c1 = list_corpora()
            .unwrap()
            .into_iter()
            .find(|c| c.name == name)
            .expect("corpus listed after first ingest");
        assert_eq!(c1.chunk_count as usize, r1.chunks_created);

        // Re-ingest with entirely different content.
        std::fs::write(&file, "betaunique betaunique betaunique filler text here").unwrap();
        let r2 = ingest_folder(opts()).expect("re-ingest");

        // Count reflects ONLY the new generation, not old+new.
        let c2 = list_corpora()
            .unwrap()
            .into_iter()
            .find(|c| c.name == name)
            .expect("corpus listed after re-ingest");
        assert_eq!(
            c2.chunk_count as usize, r2.chunks_created,
            "chunk_count should equal the new generation's chunk count"
        );

        // Old content must be gone: no surviving chunk text contains it.
        let after = search(&name, "alphaunique", 50).unwrap();
        assert!(
            after.iter().all(|h| !h.snippet.contains("alphaunique")),
            "old chunks must be swapped out, found: {after:?}"
        );
        // New content present.
        let newh = search(&name, "betaunique", 50).unwrap();
        assert!(
            newh.iter().any(|h| h.snippet.contains("betaunique")),
            "new content should be searchable"
        );

        // Cleanup.
        let _ = delete_corpus(&name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Perf review M23 (2026-06-09): search scores straight off the stored
    /// BLOB bytes now. Pin the fast path to the reference implementation so
    /// an encoding/stride regression misranks loudly here, not silently in
    /// production.
    #[test]
    fn score_blob_matches_cosine_reference() {
        let q = embed("the quick brown fox jumps over the lazy dog");
        for text in [
            "a quick brown fox jumped over a lazy hound",
            "rusqlite database transaction commit rollback",
            "the quick brown fox jumps over the lazy dog",
        ] {
            let v = embed(text);
            let blob = vec_to_blob(&v);
            let fast = score_blob(&q, &blob);
            let reference = cosine(&q, &v);
            assert!(
                (fast - reference).abs() < 1e-6,
                "score_blob {fast} != cosine {reference} for {text:?}"
            );
        }
        // Length mismatch and zero vector are 0, matching cosine semantics.
        assert_eq!(score_blob(&q, &[0u8; 8]), 0.0);
        let zero = vec_to_blob(&vec![0.0f32; EMBED_DIM]);
        assert_eq!(score_blob(&q, &zero), 0.0);
    }

    /// Perf review M26 (2026-06-09): a re-ingest with untouched files takes
    /// the copy-forward path (no re-read/re-chunk/re-embed). The copied rows
    /// must land ABOVE the watermark so the atomic swap keeps them — if the
    /// copy were broken, the swap would delete the corpus content and this
    /// search would come back empty.
    #[test]
    fn reingest_unchanged_file_carries_chunks_forward() {
        let tag = format!("{}_cf", std::process::id());
        let name = format!("__test_carryfwd_{tag}");
        let dir = std::env::temp_dir().join(format!("rag_carryfwd_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("doc.txt"),
            "gammaunique gammaunique gammaunique filler text here",
        )
        .unwrap();
        let opts = || IngestOpts {
            name: name.clone(),
            root: dir.to_string_lossy().into_owned(),
            glob: None,
        };

        let r1 = ingest_folder(opts()).expect("first ingest");
        assert!(r1.chunks_created >= 1);

        // Second ingest without touching the file — same (mtime, size).
        let r2 = ingest_folder(opts()).expect("unchanged re-ingest");
        assert_eq!(
            r2.chunks_created, r1.chunks_created,
            "carry-forward must reproduce the same chunk count"
        );
        assert_eq!(r2.files_indexed, 1);

        // Content survived the swap and is still searchable.
        let hits = search(&name, "gammaunique", 10).unwrap();
        assert!(
            hits.iter().any(|h| h.snippet.contains("gammaunique")),
            "carried-forward chunks must remain searchable, got: {hits:?}"
        );

        let _ = delete_corpus(&name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W2-RAG (2026-06-15): `corpus_stale` is false right after an ingest,
    /// becomes true when a source file changes / a new file appears / a tracked
    /// file is removed, and goes back to false after a re-ingest.
    #[test]
    fn corpus_stale_tracks_source_drift() {
        let tag = format!("{}_stale", std::process::id());
        let name = format!("__test_stale_{tag}");
        let dir = std::env::temp_dir().join(format!("rag_stale_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.txt");
        std::fs::write(&file, "stalecheck stalecheck stalecheck content here").unwrap();
        let opts = || IngestOpts {
            name: name.clone(),
            root: dir.to_string_lossy().into_owned(),
            glob: None,
        };
        ingest_folder(opts()).expect("first ingest");

        // Fresh after ingest → not stale.
        assert!(
            !corpus_stale(&name).unwrap(),
            "fresh corpus must not be stale"
        );

        // Modify the file so its SIZE changes — `corpus_stale` keys on
        // (mtime, size), and a size delta is detected independently of the
        // filesystem mtime clock granularity, keeping this test deterministic
        // without a filetime dependency.
        std::fs::write(
            &file,
            "stalecheck stalecheck CHANGED different and noticeably longer content here now",
        )
        .unwrap();
        assert!(corpus_stale(&name).unwrap(), "modified file must be stale");

        // Re-ingest → not stale again.
        ingest_folder(opts()).expect("re-ingest");
        assert!(
            !corpus_stale(&name).unwrap(),
            "re-ingested corpus must not be stale"
        );

        // A brand-new file appears → stale.
        std::fs::write(dir.join("extra.txt"), "an entirely new document file").unwrap();
        assert!(
            corpus_stale(&name).unwrap(),
            "new file must mark corpus stale"
        );

        // Unknown corpus → not stale (no error).
        assert!(!corpus_stale("__no_such_corpus_xyz").unwrap());

        let _ = delete_corpus(&name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── Hybrid retrieval (RRF) ── */

    /// RRF must rank a doc that appears in BOTH lists above one that tops only a
    /// single list, and must surface a sparse-only hit the dense list dropped.
    #[test]
    fn rrf_fuse_rewards_agreement_and_surfaces_sparse_only() {
        // Dense best-first: ids 1,2,3 (scores irrelevant to RRF — rank only).
        let dense = vec![(0.9f32, 1i64), (0.8, 2), (0.7, 3)];
        // Sparse best-first: id 2 tops it, then a brand-new id 99 the dense
        // ranking never saw, then id 1.
        let sparse = vec![(2i64, 0usize), (99, 1), (1, 2)];
        let fused = rrf_fuse(&dense, &sparse, 5);
        // id 2 is rank0 sparse + rank1 dense → highest combined RRF.
        assert_eq!(fused[0].1, 2, "doc strong in both lists must rank first");
        // The sparse-only id 99 must appear in the fused result (dense alone
        // would have dropped it entirely) — this is the exact-identifier win.
        assert!(
            fused.iter().any(|(_, id)| *id == 99),
            "sparse-only hit must be surfaced by fusion: {fused:?}"
        );
        // Determinism: re-running yields the same order.
        let again = rrf_fuse(&dense, &sparse, 5);
        assert_eq!(fused, again);
    }

    /// Fusion truncates to k and is stable for an empty sparse list (dense-only
    /// degradation) and an empty dense list (sparse-only).
    #[test]
    fn rrf_fuse_edges() {
        let dense = vec![(0.9f32, 1i64), (0.8, 2), (0.7, 3)];
        // Empty sparse → preserves dense order, trims to k.
        let only_dense = rrf_fuse(&dense, &[], 2);
        assert_eq!(only_dense.len(), 2);
        assert_eq!(only_dense[0].1, 1);
        assert_eq!(only_dense[1].1, 2);
        // Empty dense → sparse order.
        let sparse = vec![(7i64, 0usize), (8, 1)];
        let only_sparse = rrf_fuse(&[], &sparse, 5);
        assert_eq!(only_sparse[0].1, 7);
        assert_eq!(only_sparse[1].1, 8);
        // Both empty → empty.
        assert!(rrf_fuse(&[], &[], 5).is_empty());
    }

    /// End-to-end hybrid retrieval: an exact identifier / error-code token that
    /// pure dense (hashed) embedding under-ranks must be found via the fused
    /// sparse leg. Also asserts the FTS index is built lazily (the corpus is
    /// ingested before any hybrid search runs) and that `rebuild_hybrid_index`
    /// is idempotent. Runs against the shared dev DB like the other DB tests.
    #[test]
    fn hybrid_search_finds_exact_identifier() {
        let tag = format!("{}_hyb", std::process::id());
        let name = format!("__test_hybrid_{tag}");
        let dir = std::env::temp_dir().join(format!("rag_hybrid_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A file whose distinctive signal is a code-shaped identifier + an error
        // code, surrounded by unrelated prose so dense similarity to a natural-
        // language query is weak but the keyword match is exact.
        std::fs::write(
            dir.join("doc.txt"),
            "The configuration loader reads settings from disk and validates them.\n\
             When validation fails the function returns error code E0277 from the \
             handler named resolve_trait_bound which lives in the core module.\n\
             Unrelated narrative about weather, cooking, and travel follows here \
             to dilute the dense vector so the identifier carries the real signal.",
        )
        .unwrap();
        let opts = IngestOpts {
            name: name.clone(),
            root: dir.to_string_lossy().into_owned(),
            glob: None,
        };
        ingest_folder(opts).expect("ingest");

        // Query the exact error code — the sparse (BM25) leg must surface the
        // chunk even when dense ranking alone would under-rank it.
        let hits = search(&name, "E0277", 5).unwrap();
        assert!(
            hits.iter().any(|h| h.snippet.contains("E0277")),
            "exact error-code token must be found via the hybrid sparse leg: {hits:?}"
        );

        // Exact identifier with an underscore (tokenchars '_' keeps it whole).
        let hits2 = search(&name, "resolve_trait_bound", 5).unwrap();
        assert!(
            hits2
                .iter()
                .any(|h| h.snippet.contains("resolve_trait_bound")),
            "snake_case identifier must be found whole: {hits2:?}"
        );

        // rebuild_hybrid_index re-derives the sparse leg from stored chunks and
        // is idempotent — two runs (re)index the same chunk count and search
        // still works afterward.
        let n1 = rebuild_hybrid_index(&name).expect("rebuild 1");
        let n2 = rebuild_hybrid_index(&name).expect("rebuild 2");
        assert_eq!(n1, n2, "rebuild must be idempotent (same chunk count)");
        let after = search(&name, "E0277", 5).unwrap();
        assert!(
            after.iter().any(|h| h.snippet.contains("E0277")),
            "search must still work after an index rebuild: {after:?}"
        );

        let _ = delete_corpus(&name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ── vec0 ANN parity + fallback ── */

    /// Deterministic pseudo-random L2-normalized vector of dim `dim` from a seed.
    fn norm_vec(seed: u64, dim: usize) -> Vec<f32> {
        let mut s = seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1);
        let mut v: Vec<f32> = Vec::with_capacity(dim);
        for _ in 0..dim {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            // Map to [-1, 1).
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

    /// Build an in-memory DB with the RAG schema + a populated corpus of `count`
    /// normalized `dim`-vectors, the vec0 index created + backfilled. Returns
    /// (conn, corpus_id).
    fn seed_rag_corpus(count: usize, dim: usize) -> (rusqlite::Connection, i64) {
        let conn = crate::history::test_open_in_memory_with_vec();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO rag_corpora (name, root_path, chunk_count, created_at, updated_at)
             VALUES ('c', '/tmp', 0, 0, 0)",
            [],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        for i in 0..count {
            let blob = vec_to_blob(&norm_vec(i as u64 + 1, dim));
            conn.execute(
                "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                 VALUES (?1, 'p', 0, 1, 't', ?2)",
                params![cid, blob],
            )
            .unwrap();
        }
        crate::history::ensure_vec_tables_present(&conn).unwrap();
        (conn, cid)
    }

    /// Insert `count` normalized `dim`-vectors for a fresh corpus named `name`
    /// into an existing seeded DB, then refresh the vec0 index. Returns the new
    /// corpus id. Used to build a multi-corpus table in ONE shared vec0 index.
    fn add_rag_corpus(
        conn: &rusqlite::Connection,
        name: &str,
        seed_base: u64,
        count: usize,
        dim: usize,
    ) -> i64 {
        conn.execute(
            "INSERT INTO rag_corpora (name, root_path, chunk_count, created_at, updated_at)
             VALUES (?1, '/tmp', 0, 0, 0)",
            params![name],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        for i in 0..count {
            let blob = vec_to_blob(&norm_vec(seed_base + i as u64, dim));
            conn.execute(
                "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                 VALUES (?1, 'p', 0, 1, 't', ?2)",
                params![cid, blob],
            )
            .unwrap();
        }
        crate::history::ensure_vec_tables_present(conn).unwrap();
        cid
    }

    /// Recall guard (review 2026-06-14): in a SHARED global vec0 table, a small
    /// corpus must still return its true top-k even when a much larger sibling
    /// corpus dominates the global KNN candidate set. This reproduces the bug:
    /// `search_vec_rag` against the small corpus can under-recall (fewer than k
    /// of its own chunks survive the post-KNN corpus filter), while the
    /// corpus-scoped `search_linear` always returns the small corpus's real
    /// top-k. The `search`-side fallback (vec0 short → linear) closes the gap.
    #[test]
    fn vec0_rag_small_corpus_falls_back_to_linear() {
        if !crate::history::vec0_available() {
            return; // linear-only build already returns the true top-k
        }
        let dim = 16usize;
        // Big corpus 'c' (from seed_rag_corpus) + a small sibling sharing the
        // one global vec_rag_chunks index.
        let (conn, _big) = seed_rag_corpus(800, dim);
        let small = add_rag_corpus(&conn, "small", 10_000, 8, dim);
        let k = 5usize;
        // Query == the small corpus's first chunk vector, so it is guaranteed
        // to score ~1.0 and appear in the small corpus's true top-k.
        let q = norm_vec(10_000, dim);
        // The corpus-scoped linear scan defines the small corpus's true top-k.
        let lin = search_linear(&conn, small, &q, k).unwrap();
        assert!(
            !lin.is_empty(),
            "linear must find the self-match in the small corpus"
        );
        // Whatever vec0 returns for the small corpus, the search-side guard
        // (vec0 short → linear) must yield the full, correct top-k. Emulate
        // that guard here against the in-memory conn.
        let vec0 = search_vec_rag(&conn, small, &q, k).unwrap();
        let winners = if vec0.len() >= k {
            vec0
        } else {
            search_linear(&conn, small, &q, k).unwrap()
        };
        assert_eq!(
            winners.len(),
            lin.len(),
            "guarded result must match the linear true top-k count"
        );
        // The self-match (top-1) must be present and rank first.
        assert!(
            (winners[0].0 - 1.0).abs() < 1e-3,
            "guarded top-1 should be the ~1.0 self-match, got {}",
            winners[0].0
        );
        // Ids must be the small corpus's real top-k (order-independent set check).
        let mut got: Vec<i64> = winners.iter().map(|(_, id)| *id).collect();
        let mut want: Vec<i64> = lin.iter().map(|(_, id)| *id).collect();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(got, want, "guarded ids must equal the linear top-k ids");
    }

    /// vec0 KNN top-k must equal the linear top-k (ids + scores within 1e-4),
    /// and the top-1 must match exactly, over a battery of normalized vectors.
    #[test]
    fn vec0_rag_parity_with_linear() {
        if !crate::history::vec0_available() {
            return; // contract is the linear fallback on a vec0-less build
        }
        let dim = 16usize;
        let (conn, cid) = seed_rag_corpus(50, dim);
        for q_seed in [101u64, 202, 303, 404, 505] {
            let q = norm_vec(q_seed, dim);
            let k = 10;
            let vec0 = search_vec_rag(&conn, cid, &q, k).unwrap();
            let lin = search_linear(&conn, cid, &q, k).unwrap();
            assert_eq!(
                vec0.len(),
                lin.len(),
                "result count mismatch for seed {q_seed}"
            );
            assert!(!vec0.is_empty(), "expected hits for seed {q_seed}");
            // Exact top-1 id.
            assert_eq!(
                vec0[0].1, lin[0].1,
                "top-1 id mismatch for seed {q_seed}: vec0 {vec0:?} vs lin {lin:?}"
            );
            for (a, b) in vec0.iter().zip(lin.iter()) {
                assert_eq!(a.1, b.1, "id order mismatch for seed {q_seed}");
                assert!(
                    (a.0 - b.0).abs() < 1e-4,
                    "score mismatch for seed {q_seed}: vec0 {} vs lin {}",
                    a.0,
                    b.0
                );
            }
        }
    }

    /// Fallback: with vec0 unusable for the query dim, `vec0_usable_for` is
    /// false → `search` uses the linear path, which still returns correct
    /// top-k. Exercised directly via search_linear against a seeded corpus.
    #[test]
    fn vec0_rag_fallback_linear_correct() {
        let dim = 16usize;
        let (conn, cid) = seed_rag_corpus(30, dim);
        // A mismatched query dim makes vec0 unusable → linear is the path.
        assert!(!crate::history::vec0_usable_for(
            &conn,
            crate::history::VEC_RAG_CHUNKS,
            dim + 1
        ));
        // The linear path returns the self-vector (chunk seeded with seed=1) as
        // the exact top-1 when queried with that same vector.
        let q = norm_vec(1, dim);
        let lin = search_linear(&conn, cid, &q, 5).unwrap();
        assert!(!lin.is_empty());
        // The exact match scores ~1.0 and ranks first.
        assert!((lin[0].0 - 1.0).abs() < 1e-3, "self-match should score ~1");
    }
}
