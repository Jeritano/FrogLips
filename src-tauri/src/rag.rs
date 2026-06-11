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
use std::sync::Arc;

use crate::history::{get_db, now_unix};

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
    // Old DBs lack the column — the ALTER fails harmlessly when it exists.
    let _ = conn.execute(
        "ALTER TABLE rag_corpora ADD COLUMN embedder TEXT NOT NULL DEFAULT 'hashed-v1'",
        [],
    );
    Ok(())
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

/// Split `text` into chunks of at most `MAX_CHUNK_CHARS` characters with
/// `CHUNK_OVERLAP_CHARS` of overlap between adjacent chunks.
///
/// Returns a list of `(start_byte, end_byte, chunk_text)`. Operates on char
/// boundaries (not bytes) so multi-byte UTF-8 sequences are never split, but
/// reports byte offsets for downstream slicing. Empty / whitespace-only
/// inputs return an empty Vec.
pub fn chunk_text(text: &str) -> Vec<(usize, usize, String)> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let n = chars.len();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < n {
        let end = (start + MAX_CHUNK_CHARS).min(n);
        let start_byte = chars[start].0;
        // end_byte is the byte index just past the last included char.
        let end_byte = if end == n { text.len() } else { chars[end].0 };
        let slice = &text[start_byte..end_byte];
        // Skip pure-whitespace tail chunks (e.g. trailing newlines).
        if !slice.trim().is_empty() {
            out.push((start_byte, end_byte, slice.to_string()));
        }
        if end == n {
            break;
        }
        // Next window: step forward by (MAX - overlap) chars.
        let step = MAX_CHUNK_CHARS.saturating_sub(CHUNK_OVERLAP_CHARS).max(1);
        start += step;
    }
    out
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
fn flush_pending(
    conn: &mut r2d2::PooledConnection<crate::history::SqliteManager>,
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
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (start, end, chunk) in &f.chunks {
                stmt.execute(params![
                    corpus_id,
                    f.rel,
                    *start as i64,
                    *end as i64,
                    chunk,
                    vec_to_blob(&embs[ei]),
                ])?;
                ei += 1;
                *chunks_created += 1;
            }
        }
        tx.execute(
            "INSERT INTO rag_files (corpus_id, path, mtime_ms, size) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(corpus_id, path) DO UPDATE SET
               mtime_ms = excluded.mtime_ms, size = excluded.size",
            params![corpus_id, f.rel, f.mtime_ms, f.size],
        )?;
        tx.commit()?;
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
    // Pick the embedder for THIS generation up front. If it differs from the
    // one that produced the existing corpus, every carry-forward is invalid
    // (different vector space/dimension) — force a full re-embed.
    let chosen = crate::embedder::Embedder::detect();

    let mut conn = get_db()?;
    let now = now_unix();
    let (corpus_id, watermark, force_reembed): (i64, i64, bool) = {
        let tx = conn.transaction()?;
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
        let force = stored != chosen.id();
        if force {
            // Stale fingerprints would let the copy-forward resurrect vectors
            // from the old embedding space.
            tx.execute("DELETE FROM rag_files WHERE corpus_id = ?1", params![id])?;
            crate::diagnostics::info(
                "rag-ingest",
                &format!(
                    "embedder changed {stored} -> {} — full re-embed",
                    chosen.id()
                ),
            );
        }
        tx.commit()?;
        (id, wm, force)
    };
    drop(conn);

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
                let copied = conn.execute(
                    "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                     SELECT corpus_id, path, start_byte, end_byte, text, embedding
                     FROM rag_chunks
                     WHERE corpus_id = ?1 AND path = ?2 AND id <= ?3
                     ORDER BY id LIMIT ?4",
                    params![corpus_id, rel, watermark, remaining],
                )?;
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
    {
        let tx = conn.transaction()?;
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
        tx.commit()?;
    }

    Ok(IngestReport {
        corpus_id,
        files_seen,
        files_indexed,
        chunks_created,
        total_bytes,
        duration_ms: started.elapsed().as_millis(),
    })
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
                "corpus '{corpus_name}' uses '{embedder_id}' embeddings but that embedder is                  unavailable — start Ollama (or re-ingest the corpus) and retry"
            )
        })?;

    // Maturity review H1 (2026-05-27): BinaryHeap<Reverse<...>> of capacity
    // k gives O(N log k) instead of a full sort.
    //
    // Perf review M23 (2026-06-09): two-pass scan. The previous single query
    // decoded EVERY chunk's text + path Strings and converted every 2KB
    // embedding BLOB into a fresh Vec<f32> per query — ~90-100MB of
    // allocation churn and 30-100ms at a 20k-chunk corpus, just to keep the
    // top k. Pass 1 scores straight off the borrowed BLOB bytes inside the
    // row callback (zero per-row heap allocation) and keeps only (score,
    // id); pass 2 fetches path/text for the ≤50 winners by id.
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
            Ok(b) => score_blob(&q_emb, b),
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
    // Descending by score. into_sorted_vec yields ascending; reverse it.
    let mut winners: Vec<(f32, i64)> = heap
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((s, id))| (s.0, id))
        .collect();
    winners.reverse();

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
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_corpus(name: &str) -> Result<()> {
    validate_name(name)?;
    let conn = get_db()?;
    conn.execute("DELETE FROM rag_corpora WHERE name = ?1", params![name])?;
    Ok(())
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
}
