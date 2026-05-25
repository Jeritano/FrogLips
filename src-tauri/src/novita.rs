//! Novita.ai backend client.
//!
//! Novita exposes an OpenAI-compatible REST API at `https://api.novita.ai/v3/openai`.
//! This module covers the *non-streaming* control surface only:
//!   - listing the catalog of models the user's key can access
//!   - probing the key for validity
//!
//! Chat streaming itself happens in the frontend (`src/lib/novita-client.ts`)
//! so we don't have to plumb SSE through Tauri IPC. The frontend fetches the
//! API key just-in-time via the `novita_get_key` command and discards it
//! after the request completes.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub const BASE_URL: &str = "https://api.novita.ai/v3/openai";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY_PREVIEW: usize = 256;

#[derive(Deserialize)]
struct ModelsResp {
    data: Vec<NovitaModel>,
}

#[derive(Deserialize)]
struct NovitaModel {
    id: String,
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .https_only(true)
        .user_agent("Froglips/0.6")
        .build()
        .context("build reqwest client")
}

/// Fetch the model catalog for the given API key. Returns `ModelEntry` values
/// with backend = "novita" and size_bytes = 0 (Novita doesn't report sizes).
pub async fn list_models(api_key: &str) -> Result<Vec<crate::models::ModelEntry>> {
    if api_key.is_empty() {
        return Err(anyhow!("novita api key not set"));
    }
    let url = format!("{BASE_URL}/models");
    let resp = client()?
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .context("novita /models request failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let preview: String = body.chars().take(MAX_BODY_PREVIEW).collect();
        return Err(anyhow!("novita /models {status}: {preview}"));
    }
    let parsed: ModelsResp = resp.json().await.context("parse novita /models")?;
    let mut out: Vec<crate::models::ModelEntry> = parsed
        .data
        .into_iter()
        .map(|m| crate::models::ModelEntry {
            id: m.id,
            size_bytes: 0,
            backend: "novita".into(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Cheap probe — just runs `list_models` and discards the catalog.
pub async fn probe(api_key: &str) -> Result<()> {
    list_models(api_key).await.map(|_| ())
}
