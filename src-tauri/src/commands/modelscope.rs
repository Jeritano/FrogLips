//! ModelScope catalog proxy. The ModelScope model APIs
//! (`PUT modelscope.cn/api/v1/dolphin/models` and the inference list) do not
//! send CORS headers, so the webview can't fetch them directly (unlike
//! HuggingFace). We proxy here through reqwest and hand back a trimmed,
//! typed model list with avatar/cover image URLs so the frontend can render
//! cards matching the ModelScope site.
//!
//! Inference is unrelated to this command — a ModelScope model is *used* via
//! its OpenAI-compatible endpoint (`api-inference.modelscope.cn/v1`) registered
//! as a normal custom backend on the frontend.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Clone, Default)]
pub struct MsModel {
    /// `org/name` — the id used both as the display id and the inference model.
    pub repo: String,
    pub name: String,
    pub org: String,
    pub downloads: u64,
    pub stars: u64,
    /// Epoch seconds of last update (0 if unknown).
    pub last_updated: i64,
    /// First pipeline task (e.g. "text-generation"), if any.
    pub task: Option<String>,
    /// Whether ModelScope serves this model via its inference API (→ usable in
    /// chat). Non-servable models can only be opened on the site.
    pub support_api_inference: bool,
    /// Org logo URL (shown on the card head). ModelScope's model cards use the
    /// org avatar as the card image.
    pub avatar: Option<String>,
    /// Optional cover/banner image URL (only some featured models have one).
    pub cover: Option<String>,
}

fn ms_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Cap on a single ModelScope response body. This is the only outbound HTTP
/// surface in the app that previously did an unbounded `resp.json()`; a
/// compromised/MITM'd host could OOM us. 8 MiB is far above any real
/// model-catalog page.
const MS_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Cap on the per-org dolphin fan-out so a response listing hundreds of
/// distinct orgs can't trigger a burst of hundreds of parallel PUTs.
const MS_MAX_ORG_FANOUT: usize = 16;

/// Bounded JSON read — streams the body and aborts past `MS_MAX_BYTES`.
async fn read_json_capped(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > MS_MAX_BYTES {
            return Err(format!("ModelScope response too large ({len} bytes)"));
        }
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("ModelScope body error: {e}"))?
    {
        if buf.len() + chunk.len() > MS_MAX_BYTES {
            return Err("ModelScope response exceeds size cap".into());
        }
        buf.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&buf).map_err(|e| format!("ModelScope bad JSON: {e}"))
}

/// One dolphin catalog search by `name`, returning the raw model objects.
async fn dolphin_search(
    client: &reqwest::Client,
    name: &str,
    page_size: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let body = serde_json::json!({
        "PageSize": page_size,
        "PageNumber": 1,
        "SortBy": "DownloadsCount",
        "Name": name,
    });
    let resp = client
        .put("https://modelscope.cn/api/v1/dolphin/models")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ModelScope request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ModelScope returned HTTP {}", resp.status()));
    }
    let v: serde_json::Value = read_json_capped(resp).await?;
    // The model array lives at Data.Model.Models (older builds: Data.Models).
    Ok(v["Data"]["Model"]["Models"]
        .as_array()
        .or_else(|| v["Data"]["Models"].as_array())
        .cloned()
        .unwrap_or_default())
}

/// Map a raw dolphin model object → `MsModel` (None if it lacks org/name).
fn model_from_dolphin(m: &serde_json::Value) -> Option<MsModel> {
    let name = m["Name"].as_str()?.to_string();
    let org = m["Path"].as_str()?.to_string();
    if name.is_empty() || org.is_empty() {
        return None;
    }
    let avatar = m["Avatar"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let cover = m["CoverImages"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|c| c.as_str().or_else(|| c["Url"].as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(MsModel {
        repo: format!("{org}/{name}"),
        name,
        org,
        downloads: m["Downloads"].as_u64().unwrap_or(0),
        stars: m["Stars"].as_u64().unwrap_or(0),
        last_updated: m["LastUpdatedTime"].as_i64().unwrap_or(0),
        // Tasks elements are objects with a `Name` field, not bare strings.
        task: m["Tasks"]
            .as_array()
            .and_then(|t| t.first())
            .and_then(|t| t["Name"].as_str().or_else(|| t.as_str()))
            .map(str::to_string),
        support_api_inference: m["SupportApiInference"].as_bool().unwrap_or(false),
        avatar,
        cover,
    })
}

/// The inference API's `/v1/models` → `(repo, created_epoch)` for every model
/// servable via ModelScope's OpenAI-compatible endpoint (all "Use in chat").
async fn inference_models(client: &reqwest::Client) -> Result<Vec<(String, i64)>, String> {
    let resp = client
        .get("https://api-inference.modelscope.cn/v1/models")
        .send()
        .await
        .map_err(|e| format!("ModelScope inference list failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ModelScope returned HTTP {}", resp.status()));
    }
    let v: serde_json::Value = read_json_capped(resp).await?;
    let mut out = Vec::new();
    for m in v["data"].as_array().cloned().unwrap_or_default() {
        let id = m["id"].as_str().unwrap_or_default().to_string();
        if id.is_empty() {
            continue;
        }
        out.push((id, m["created"].as_i64().unwrap_or(0)));
    }
    Ok(out)
}

/// List/search connectable ModelScope LLMs as cards (with avatar/cover images).
///   * No query → the inference API's `/v1/models` (the exact set of models
///     servable via ModelScope's OpenAI-compatible endpoint → all "Use in
///     chat"), enriched with org avatars + real download/star counts pulled
///     from the dolphin catalog (one lookup per org, in parallel). This avoids
///     the dolphin default browse being dominated by ASR/CV models you can't
///     chat with (its `text-generation` filter is ignored server-side).
///   * Query → the dolphin catalog search (richer metadata) by name.
#[tauri::command]
pub async fn modelscope_search(query: Option<String>) -> Result<Vec<MsModel>, String> {
    let name = query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let client = ms_client()?;

    // ── Search: dolphin by name (already carries avatar/cover/downloads/stars) ──
    if let Some(q) = name {
        let arr = dolphin_search(&client, &q, 40).await?;
        let mut out: Vec<MsModel> = arr.iter().filter_map(model_from_dolphin).collect();
        // Mark rows that are actually connectable via the inference set.
        if let Ok(models) = inference_models(&client).await {
            let set: HashSet<String> = models.into_iter().map(|(r, _)| r).collect();
            for m in &mut out {
                if set.contains(&m.repo) {
                    m.support_api_inference = true;
                }
            }
        }
        return Ok(out);
    }

    // ── Default browse: connectable inference LLMs, enriched per-org ──
    let ids = inference_models(&client).await?;

    let mut orgs: Vec<String> = ids
        .iter()
        .map(|(r, _)| r.split('/').next().unwrap_or("").to_string())
        .filter(|o| !o.is_empty())
        .collect();
    orgs.sort();
    orgs.dedup();
    orgs.truncate(MS_MAX_ORG_FANOUT);

    // One dolphin lookup per org, in parallel, to harvest the org avatar and
    // (where the exact repo appears) real download/star/cover metadata.
    let mut set = tokio::task::JoinSet::new();
    for org in orgs {
        let c = client.clone();
        set.spawn(async move {
            let arr = dolphin_search(&c, &org, 30).await.unwrap_or_default();
            let mut org_avatar: Option<String> = None;
            let mut meta: HashMap<String, MsModel> = HashMap::new();
            for m in arr.iter().filter_map(model_from_dolphin) {
                if m.org == org && org_avatar.is_none() {
                    org_avatar = m.avatar.clone();
                }
                meta.insert(m.repo.clone(), m);
            }
            (org, org_avatar, meta)
        });
    }
    let mut org_avatars: HashMap<String, String> = HashMap::new();
    let mut repo_meta: HashMap<String, MsModel> = HashMap::new();
    while let Some(res) = set.join_next().await {
        if let Ok((org, avatar, meta)) = res {
            if let Some(a) = avatar {
                org_avatars.insert(org, a);
            }
            repo_meta.extend(meta);
        }
    }

    let mut out = Vec::with_capacity(ids.len());
    for (repo, created) in ids {
        let org = repo.split('/').next().unwrap_or("").to_string();
        let nm = repo.split('/').nth(1).unwrap_or(&repo).to_string();
        let meta = repo_meta.get(&repo);
        out.push(MsModel {
            repo: repo.clone(),
            name: nm,
            org: org.clone(),
            downloads: meta.map(|m| m.downloads).unwrap_or(0),
            stars: meta.map(|m| m.stars).unwrap_or(0),
            last_updated: meta
                .map(|m| m.last_updated)
                .filter(|&t| t > 0)
                .unwrap_or(created),
            task: meta
                .and_then(|m| m.task.clone())
                .or_else(|| Some("text-generation".to_string())),
            support_api_inference: true,
            avatar: meta
                .and_then(|m| m.avatar.clone())
                .or_else(|| org_avatars.get(&org).cloned()),
            cover: meta.and_then(|m| m.cover.clone()),
        });
    }
    // Most-downloaded first; stable tiebreak on repo.
    out.sort_by(|a, b| b.downloads.cmp(&a.downloads).then_with(|| a.repo.cmp(&b.repo)));
    Ok(out)
}
