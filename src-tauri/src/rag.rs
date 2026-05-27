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
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::history::{get_db, now_unix};

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
         CREATE INDEX IF NOT EXISTS idx_rag_chunks_corpus ON rag_chunks(corpus_id);",
    )?;
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

/// Backwards-compatible alias. Kept so existing callers don't need an
/// atomic rename across the crate; new code should use the explicit name.
#[inline]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    cosine_normalized(a, b)
}

#[inline]
fn is_unit_length(v: &[f32]) -> bool {
    if v.is_empty() {
        return true;
    }
    let sq: f32 = v.iter().map(|x| x * x).sum();
    (sq - 1.0).abs() < 1e-3
}

use crate::util::{blob_to_vec, vec_to_blob};

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
            if name_s.starts_with('.') && path != root {
                // Allow .env-style top-of-file docs but not VCS/config dirs.
                if path.is_dir() {
                    continue;
                }
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

pub fn ingest_folder(opts: IngestOpts) -> Result<IngestReport> {
    validate_name(&opts.name)?;
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

    // Insert/update corpus row.
    let conn = get_db()?;
    let now = now_unix();
    conn.execute(
        "INSERT INTO rag_corpora (name, root_path, chunk_count, created_at, updated_at)
         VALUES (?1, ?2, 0, ?3, ?3)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path, updated_at = ?3",
        params![&opts.name, root_canon.to_string_lossy(), now],
    )?;
    let corpus_id: i64 = conn.query_row(
        "SELECT id FROM rag_corpora WHERE name = ?1",
        params![&opts.name],
        |r| r.get(0),
    )?;
    // Clear prior chunks for re-ingest semantics.
    conn.execute(
        "DELETE FROM rag_chunks WHERE corpus_id = ?1",
        params![corpus_id],
    )?;
    drop(conn);

    let mut files_indexed = 0usize;
    let mut chunks_created = 0usize;
    let mut total_bytes: u64 = 0;

    // Batch insert per file to keep transactions small.
    let mut conn = get_db()?;
    for file in &files {
        if chunks_created >= MAX_CHUNKS_PER_INGEST {
            break;
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
        let text = match std::fs::read_to_string(file) {
            Ok(t) => t,
            Err(e) => {
                crate::diagnostics::info(
                    "rag-ingest",
                    &format!("skipping non-utf8/unreadable {} ({})", file.display(), e),
                );
                continue;
            }
        };
        total_bytes += text.len() as u64;
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            continue;
        }
        let rel = file
            .strip_prefix(&root_canon)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO rag_chunks (corpus_id, path, start_byte, end_byte, text, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (s, e, chunk) in &chunks {
                // Defense-in-depth: chunks that obviously embed prompt-
                // injection markers are flagged here so they never enter
                // the corpus in the first place. Search-time `scan_and_wrap`
                // (line ~516) still runs as a second layer for chunks that
                // slipped past these heuristics; pairing both makes
                // attacker-controlled docs harder to weaponize.
                let (_wrapped, hits) = crate::agent::injection_scan::scan_and_wrap(chunk);
                if hits > 0 {
                    crate::diagnostics::warn_with(
                        "rag-ingest",
                        "skipped chunk with injection markers",
                        serde_json::json!({
                            "path": rel,
                            "start": *s,
                            "end": *e,
                            "hits": hits,
                        }),
                    );
                    continue;
                }
                let emb = embed(chunk);
                stmt.execute(params![
                    corpus_id,
                    rel,
                    *s as i64,
                    *e as i64,
                    chunk,
                    vec_to_blob(&emb),
                ])?;
                chunks_created += 1;
                if chunks_created >= MAX_CHUNKS_PER_INGEST {
                    break;
                }
            }
        }
        tx.commit()?;
        files_indexed += 1;
    }

    conn.execute(
        "UPDATE rag_corpora SET chunk_count = ?1, updated_at = ?2 WHERE id = ?3",
        params![chunks_created as i64, now_unix(), corpus_id],
    )?;

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
    let q_emb = embed(trimmed);

    let conn = get_db()?;
    let corpus_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM rag_corpora WHERE name = ?1",
            params![corpus_name],
            |r| r.get(0),
        )
        .ok();
    let corpus_id = match corpus_id {
        Some(id) => id,
        None => anyhow::bail!("corpus '{}' not found", corpus_name),
    };

    let mut stmt = conn.prepare(
        "SELECT path, start_byte, end_byte, text, embedding FROM rag_chunks
         WHERE corpus_id = ?1",
    )?;
    let rows = stmt.query_map(params![corpus_id], |r| {
        let path: String = r.get(0)?;
        let s: i64 = r.get(1)?;
        let e: i64 = r.get(2)?;
        let text: String = r.get(3)?;
        let blob: Vec<u8> = r.get(4)?;
        Ok((path, s, e, text, blob))
    })?;

    // Maturity review H1 (2026-05-27): previous impl pushed every
    // positive-scored chunk into a Vec and full-sorted at the end —
    // O(N log N) over ~50k chunks. Switched to a BinaryHeap<Reverse<...>>
    // of capacity k, which gives O(N log k). For top_k=10 against 50k
    // chunks that's ~50k × log2(10) ≈ 165k cmps vs the old 50k × log2(50k)
    // ≈ 780k. The win compounds when the user expands the corpus.
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
    type Entry = (OrderedF32, String, i64, i64, String);
    let mut heap: BinaryHeap<Reverse<Entry>> = BinaryHeap::with_capacity(k + 1);
    for row in rows {
        let (path, s, e, text, blob) = row?;
        let emb = blob_to_vec(&blob);
        let score = cosine(&q_emb, &emb);
        if score <= 0.0 {
            continue;
        }
        heap.push(Reverse((OrderedF32(score), path, s, e, text)));
        // Trim back to k by dropping the smallest. `pop` on a min-heap
        // is O(log k).
        if heap.len() > k {
            heap.pop();
        }
    }
    // Drain newest-first by repeatedly popping the heap. Heap pops the
    // smallest first (we wrapped in Reverse), so collect into a Vec and
    // reverse at the end for descending order.
    let mut scored: Vec<(f32, String, i64, i64, String)> = heap
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((s, p, sb, eb, t))| (s.0, p, sb, eb, t))
        .collect();
    // into_sorted_vec yields ascending order (smallest first); reverse
    // for the descending-by-score contract the caller expects.
    scored.reverse();
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
}
