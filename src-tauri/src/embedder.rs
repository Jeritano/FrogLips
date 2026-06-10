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

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub const HASHED_ID: &str = "hashed-v1";
pub const OLLAMA_MODEL: &str = "nomic-embed-text";
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
}

impl Embedder {
    pub fn id(&self) -> &'static str {
        match self {
            Embedder::Hashed => HASHED_ID,
            Embedder::Ollama => OLLAMA_MODEL,
        }
    }

    pub fn from_id(id: &str) -> Embedder {
        if id == OLLAMA_MODEL {
            Embedder::Ollama
        } else {
            Embedder::Hashed
        }
    }

    /// Pick the best available embedder right now: Ollama + nomic-embed-text
    /// when the daemon answers and the model is installed, else hashed.
    pub fn detect() -> Embedder {
        if ollama_has_embed_model() {
            Embedder::Ollama
        } else {
            Embedder::Hashed
        }
    }

    /// Embed a batch of texts. Hashed never fails; Ollama errors surface to
    /// the caller (ingest aborts cleanly rather than silently mixing vector
    /// spaces).
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        match self {
            Embedder::Hashed => Ok(texts.iter().map(|t| crate::rag::embed(t)).collect()),
            Embedder::Ollama => ollama_embed_batch(texts),
        }
    }

    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_batch(&[text])?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("embedder returned no vector"))
    }
}

fn blocking_client(timeout: Duration) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .context("build blocking http client")
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
    let Ok(client) = blocking_client(PROBE_TIMEOUT) else {
        return false;
    };
    let Ok(resp) = client.get(format!("{OLLAMA_BASE}/api/tags")).send() else {
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
    let client = blocking_client(EMBED_TIMEOUT)?;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(BATCH) {
        let resp = client
            .post(format!("{OLLAMA_BASE}/api/embed"))
            .json(&serde_json::json!({ "model": OLLAMA_MODEL, "input": chunk }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        assert_eq!(Embedder::from_id(HASHED_ID), Embedder::Hashed);
        assert_eq!(Embedder::from_id(OLLAMA_MODEL), Embedder::Ollama);
        // Unknown ids degrade to hashed (old DBs, future ids).
        assert_eq!(Embedder::from_id("bge-small-future"), Embedder::Hashed);
        assert_eq!(Embedder::Hashed.id(), HASHED_ID);
        assert_eq!(Embedder::Ollama.id(), OLLAMA_MODEL);
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
