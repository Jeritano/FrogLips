//! Pluggable text embedder for the RAG pipeline (product review Act 2, 2026-06-10).
//!
//! The original hashed bag-of-words vectorizer (`rag::embed`) is deterministic
//! and dependency-free but keyword-grade: "how do we authenticate users" can't
//! find "login session validation". This module upgrades RAG to LEARNED
//! embeddings when an embedding model is available, with the hashed vectorizer
//! retained as the always-works fallback:
//!
//!   1. `nomic-embed-text` served by the local Ollama daemon (batch
//!      `/api/embed`, 768-dim, L2-normalized here). Chosen over bundling an
//!      ONNX runtime: the memory system already standardizes on this model,
//!      most users have the daemon, and it adds zero build/bundle weight.
//!      (ONNX bge-small via `ort` stays on the roadmap for daemon-less
//!      installs.)
//!   2. `hashed-v1` — the original 512-dim hashed vectorizer.
//!
//! Every corpus records which embedder produced its vectors
//! (`rag_corpora.embedder`); queries are embedded with the CORPUS's embedder
//! so vectors of different models/dimensions are never cross-scored.
//!
//! All HTTP here is `reqwest::blocking` — ingest and search already run on
//! the blocking pool (`commands::agent::blocking`), never on async workers.
//!
//! ## Daemon-less semantic embeddings (W5-RAGCORE, 2026-06-15) — status
//!
//! Goal: semantic RAG/recall WITHOUT Ollama. This module is the single
//! abstraction every embedding flows through, and every corpus already records
//! the embedder that produced its vectors (`rag_corpora.embedder`) so vectors
//! of different models/dims are NEVER cross-scored — the fingerprint guard the
//! daemon-less path also relies on. Two things landed here now:
//!
//!   * The `Candle` variant + `CANDLE_ID` fingerprint are wired through `id()` /
//!     `from_id()` / the dim + cross-score guards, and `detect()` will prefer an
//!     available in-process embedder over the weaker hashed fallback. So the
//!     plumbing, fingerprinting, and "no embedder available" degradation are
//!     complete and a corpus tagged `Candle` can never be silently queried with
//!     a different model's vectors.
//!   * `candle_available()` / `candle_embed_batch()` are the seam where a real
//!     in-process model runner plugs in. Today they report unavailable + return
//!     a precise error, so `detect()` cleanly falls back (Ollama → Hashed) and
//!     nothing regresses.
//!
//! PARTIAL — the in-process model RUNNER itself is deliberately NOT landed in
//! this pass. A correct bge-small / all-MiniLM forward pass needs an always-on
//! `candle-nn` + `candle-transformers` + `tokenizers` + `hf-hub` +
//! `safetensors` dependency surface (candle-core is already a dep, but those are
//! only pulled transitively under the optional `native-mistralrs` feature today)
//! plus a model download + tokenizer + mean-pool + caching path. Forcing those
//! always-on risks the bundle-budget / notarization / dual-feature clippy gates,
//! and a half-correct embedder would silently misrank. So we ship the safe
//! abstraction + fingerprint guard + clean degradation now; see
//! `candle_embed_batch` for the exact remaining work. Meanwhile the hybrid
//! retrieval added in `rag::search` (BM25 sparse leg fused with the hashed dense
//! leg via RRF) already gives strong keyword/identifier recall daemon-free.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub const HASHED_ID: &str = "hashed-v1";
pub const OLLAMA_MODEL: &str = "nomic-embed-text";
/// Fingerprint for the (partial) in-process candle embedder. Stored in
/// `rag_corpora.embedder` so a corpus embedded in-process is queried in-process
/// and never cross-scored against Ollama / hashed vectors. The concrete model
/// name is folded in so a future model swap (bge-small → all-MiniLM) bumps the
/// fingerprint and forces a clean re-embed rather than mixing spaces.
pub const CANDLE_ID: &str = "candle-bge-small-en-v1.5";
const OLLAMA_BASE: &str = "http://127.0.0.1:11434";
/// Chunks per `/api/embed` call. Ollama handles large batches fine; 64 keeps
/// per-request latency and payload size sane for 512-char chunks.
const BATCH: usize = 64;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const EMBED_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq)]
pub enum Embedder {
    Hashed,
    Ollama,
    /// In-process learned embedder (daemon-less). PARTIAL: the model runner is
    /// not yet implemented (see module docs + `candle_embed_batch`); the variant
    /// exists so the fingerprint + cross-score guards are complete and a future
    /// runner is a drop-in. `detect()` only ever returns this once
    /// `candle_available()` reports true, so today it stays inert.
    Candle,
}

impl Embedder {
    pub fn id(&self) -> &'static str {
        match self {
            Embedder::Hashed => HASHED_ID,
            Embedder::Ollama => OLLAMA_MODEL,
            Embedder::Candle => CANDLE_ID,
        }
    }

    pub fn from_id(id: &str) -> Embedder {
        if id == OLLAMA_MODEL {
            Embedder::Ollama
        } else if id == CANDLE_ID {
            Embedder::Candle
        } else {
            // Unknown ids (old DBs, future fingerprints) degrade to hashed —
            // the always-works space.
            Embedder::Hashed
        }
    }

    /// Pick the best available embedder right now. Preference order: the local
    /// Ollama daemon (`nomic-embed-text`) when up, else the in-process candle
    /// learned embedder when available (daemon-less semantic path), else the
    /// always-works hashed fallback. Candle sits BELOW Ollama deliberately — a
    /// user who already runs the daemon keeps the established 768-dim space and
    /// avoids a download; candle is the upgrade ONLY for daemon-less installs.
    pub fn detect() -> Embedder {
        if ollama_has_embed_model() {
            Embedder::Ollama
        } else if candle_available() {
            Embedder::Candle
        } else {
            Embedder::Hashed
        }
    }

    /// Embed a batch of texts. Hashed never fails; Ollama + Candle errors
    /// surface to the caller (ingest aborts cleanly rather than silently mixing
    /// vector spaces).
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        match self {
            Embedder::Hashed => Ok(texts.iter().map(|t| crate::rag::embed(t)).collect()),
            Embedder::Ollama => ollama_embed_batch(texts),
            Embedder::Candle => candle_embed_batch(texts),
        }
    }

    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_batch(&[text])?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("embedder returned no vector"))
    }
}

/// Static clients (perf, 2026-06-11): each blocking::Client spawns a
/// dedicated runtime thread on build — per-call construction paid that for
/// every probe and every 64-chunk batch. Two singletons (probe vs embed)
/// because their timeouts differ.
fn probe_client() -> &'static reqwest::blocking::Client {
    static C: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        crate::net::blocking_client_builder()
            .timeout(PROBE_TIMEOUT)
            .build()
            .expect("build probe client")
    })
}

fn embed_client() -> &'static reqwest::blocking::Client {
    static C: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        crate::net::blocking_client_builder()
            .timeout(EMBED_TIMEOUT)
            .build()
            .expect("build embed client")
    })
}

/// True when the local Ollama daemon is up AND has nomic-embed-text pulled.
fn ollama_has_embed_model() -> bool {
    #[derive(Deserialize)]
    struct Tags {
        #[serde(default)]
        models: Vec<TagModel>,
    }
    #[derive(Deserialize)]
    struct TagModel {
        name: String,
    }
    let Ok(resp) = probe_client().get(format!("{OLLAMA_BASE}/api/tags")).send() else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(tags) = resp.json::<Tags>() else {
        return false;
    };
    tags.models.iter().any(|m| m.name.starts_with(OLLAMA_MODEL))
}

fn ollama_embed_batch(texts: &[&str]) -> Result<Vec<Vec<f32>>> {
    #[derive(Deserialize)]
    struct EmbedResp {
        #[serde(default)]
        embeddings: Vec<Vec<f32>>,
    }
    // keep_alive: without it the daemon unloads nomic-embed-text after its
    // 5m default, putting a cold-load in front of the next recall/ingest.
    let keep_alive = crate::settings::load()
        .ollama_keep_alive
        .unwrap_or_else(|| "30m".to_string());
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(BATCH) {
        let resp = embed_client()
            .post(format!("{OLLAMA_BASE}/api/embed"))
            .json(&serde_json::json!({ "model": OLLAMA_MODEL, "input": chunk, "keep_alive": keep_alive }))
            .send()
            .context("POST /api/embed")?;
        if !resp.status().is_success() {
            let st = resp.status();
            let body = resp.text().unwrap_or_default();
            let snippet: String = body.chars().take(200).collect();
            anyhow::bail!("ollama embed failed ({st}): {snippet}");
        }
        let parsed: EmbedResp = resp.json().context("parse /api/embed response")?;
        if parsed.embeddings.len() != chunk.len() {
            anyhow::bail!(
                "ollama embed returned {} vectors for {} inputs",
                parsed.embeddings.len(),
                chunk.len()
            );
        }
        for mut v in parsed.embeddings {
            l2_normalize(&mut v);
            out.push(v);
        }
    }
    Ok(out)
}

/// Normalize in place so downstream scoring stays a plain dot product —
/// the same invariant the hashed vectorizer already guarantees.
fn l2_normalize(v: &mut [f32]) {
    let sq: f32 = v.iter().map(|x| x * x).sum();
    if sq > 0.0 {
        let inv = sq.sqrt().recip();
        for x in v.iter_mut() {
            *x *= inv;
        }
    }
}

/* ── Daemon-less in-process candle embedder (PARTIAL — see module docs) ── */

/// Whether the in-process candle learned embedder can serve embeddings right now.
///
/// PARTIAL: returns `false` unconditionally today, so `detect()` never selects
/// the `Candle` variant and the daemon-less path stays inert (clean Ollama →
/// Hashed degradation). When the model runner below is implemented, this becomes
/// "is the model file present / downloadable AND does the candle device init".
fn candle_available() -> bool {
    false
}

/// Embed a batch in-process via candle (bge-small-en-v1.5), L2-normalized to
/// keep the dot-product scoring invariant. PARTIAL — NOT YET IMPLEMENTED.
///
/// Remaining work to land this safely (intentionally deferred this pass):
///   1. Add always-on deps: `candle-nn`, `candle-transformers` (BertModel),
///      `tokenizers`, `hf-hub`, `safetensors`. `candle-core` is already a
///      top-level dep; the others are currently only pulled transitively under
///      the optional `native-mistralrs` feature, so they must be promoted to
///      unconditional `[dependencies]` (watch the bundle-budget + notarization
///      gates — all are pure-Rust / no new C dylib, which is why candle was
///      chosen over `ort`/ONNX).
///   2. First-use download of `BAAI/bge-small-en-v1.5` (config.json,
///      tokenizer.json, model.safetensors) via `hf-hub` into the app data dir,
///      with a size/checksum guard and offline reuse.
///   3. Load BertModel on the candle Metal device (fallback CPU), tokenize with
///      the HF tokenizer, run the forward pass, MEAN-POOL the last hidden state
///      over the attention mask, then `l2_normalize`. Cache the loaded model in
///      a `OnceLock` so repeated batches don't re-load.
///   4. Bump `CANDLE_ID` if the model changes so the fingerprint guard forces a
///      clean re-embed rather than mixing spaces.
///
/// Until then this returns a precise, actionable error. It is never reached in
/// normal operation because `candle_available()` is `false` (so `detect()`
/// never picks `Candle`); it can only be hit if a corpus's stored fingerprint
/// is `CANDLE_ID` on a build without the runner — in which case the corpus must
/// be re-ingested (the error tells the user exactly that).
fn candle_embed_batch(_texts: &[&str]) -> Result<Vec<Vec<f32>>> {
    Err(anyhow!(
        "in-process candle embedder is not available in this build — \
         re-ingest the corpus (it will use Ollama if running, else the \
         keyword-grade hashed embedder)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        assert_eq!(Embedder::from_id(HASHED_ID), Embedder::Hashed);
        assert_eq!(Embedder::from_id(OLLAMA_MODEL), Embedder::Ollama);
        assert_eq!(Embedder::from_id(CANDLE_ID), Embedder::Candle);
        // Unknown ids degrade to hashed (old DBs, future ids).
        assert_eq!(Embedder::from_id("bge-small-future"), Embedder::Hashed);
        assert_eq!(Embedder::Hashed.id(), HASHED_ID);
        assert_eq!(Embedder::Ollama.id(), OLLAMA_MODEL);
        assert_eq!(Embedder::Candle.id(), CANDLE_ID);
        // Every id round-trips through from_id → id (fingerprint guard relies on
        // this: a stored fingerprint must map back to the same embedder).
        for e in [Embedder::Hashed, Embedder::Ollama, Embedder::Candle] {
            assert_eq!(Embedder::from_id(e.id()), e);
        }
    }

    /// PARTIAL candle path: the runner isn't implemented, so `candle_available`
    /// is false and `candle_embed_batch` returns a precise error rather than
    /// silently producing garbage vectors. This pins the safe degradation.
    #[test]
    fn candle_is_inert_until_runner_lands() {
        assert!(
            !candle_available(),
            "candle must report unavailable for now"
        );
        let err = candle_embed_batch(&["x"]).unwrap_err().to_string();
        assert!(
            err.contains("not available") && err.contains("re-ingest"),
            "candle error must be actionable: {err}"
        );
    }

    #[test]
    fn hashed_batch_matches_rag_embed() {
        let texts = ["alpha beta", "gamma delta"];
        let batch = Embedder::Hashed.embed_batch(&texts).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0], crate::rag::embed("alpha beta"));
        assert_eq!(batch[1], crate::rag::embed("gamma delta"));
    }

    #[test]
    fn l2_normalize_unit_length() {
        let mut v = vec![3.0f32, 4.0];
        l2_normalize(&mut v);
        let sq: f32 = v.iter().map(|x| x * x).sum();
        assert!((sq - 1.0).abs() < 1e-6);
        // Zero vector stays zero (no NaN).
        let mut z = vec![0.0f32; 4];
        l2_normalize(&mut z);
        assert!(z.iter().all(|x| *x == 0.0));
    }
}
