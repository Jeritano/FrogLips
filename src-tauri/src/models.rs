use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Cache: model dir path → (mtime, total size bytes). Avoids walking every
/// `models--*` directory on each list call. Invalidated by mtime change.
static DIR_SIZE_CACHE: Lazy<Mutex<HashMap<PathBuf, (SystemTime, u64)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Clone)]
pub struct ModelEntry {
    pub id: String,
    pub size_bytes: u64,
    pub backend: String, // "mlx" | "ollama"
}

pub fn list_mlx_models() -> Result<Vec<ModelEntry>> {
    let hub = hf_hub_dir();
    if !hub.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&hub)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(rest) = name.strip_prefix("models--") else {
            continue;
        };
        // HF encodes "org/sub/name" as "org--sub--name"; replace ALL "--" → "/"
        let id = rest.replace("--", "/");
        let size_bytes = cached_dir_size(&entry.path()).unwrap_or(0);
        out.push(ModelEntry {
            id,
            size_bytes,
            backend: "mlx".into(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Ollama daemon address for the local HTTP API. Mirrors the constants in
/// `backend_process` but kept local so this module has no cross-dep on the
/// process layer for a plain discovery call.
const OLLAMA_API_BASE: &str = "http://127.0.0.1:11434";

/// Discover installed Ollama models. Prefers the daemon's HTTP API
/// (`GET /api/tags`) — it's more robust than parsing `ollama list`'s
/// space-aligned columns, returns exact `size` in bytes, and (via
/// `/api/show`) exposes family/capability metadata. Falls back to the
/// `ollama list` shell-out when the daemon isn't reachable (not started yet),
/// so a user who has the CLI but no running `ollama serve` still sees their
/// models.
pub fn list_ollama_models() -> Result<Vec<ModelEntry>> {
    match list_ollama_models_http() {
        Ok(v) => Ok(v),
        Err(http_err) => {
            // Daemon unreachable (common: not started). Fall back to the CLI;
            // if THAT also fails, surface the more actionable HTTP error so the
            // UI hint points at the daemon rather than a confusing parse error.
            list_ollama_models_cli().map_err(|cli_err| {
                anyhow::anyhow!("{http_err}; CLI fallback also failed: {cli_err}")
            })
        }
    }
}

/// `GET /api/tags` against the local daemon. Returns each model with its exact
/// on-disk byte size. A short timeout keeps a wedged daemon from stalling the
/// model-list call (the same budget the old CLI path used).
fn list_ollama_models_http() -> Result<Vec<ModelEntry>> {
    use std::time::Duration;

    #[derive(serde::Deserialize)]
    struct TagsResponse {
        #[serde(default)]
        models: Vec<TagModel>,
    }
    #[derive(serde::Deserialize)]
    struct TagModel {
        #[serde(default)]
        name: String,
        #[serde(default)]
        size: u64,
    }

    // Blocking reqwest client (the `blocking` feature is already enabled in
    // Cargo.toml). list_ollama_models runs inside a `blocking(...)` task, so a
    // synchronous client is correct here and avoids spinning up a runtime.
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to build ollama http client")?;
    let resp = client
        .get(format!("{OLLAMA_API_BASE}/api/tags"))
        .send()
        .context("ollama daemon not reachable at /api/tags")?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!(
            "ollama /api/tags returned HTTP {}",
            resp.status()
        ));
    }
    let parsed: TagsResponse = resp.json().context("invalid /api/tags JSON")?;
    let mut out: Vec<ModelEntry> = parsed
        .models
        .into_iter()
        .filter(|m| !m.name.is_empty())
        .map(|m| ModelEntry {
            id: m.name,
            size_bytes: m.size,
            backend: "ollama".into(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn list_ollama_models_cli() -> Result<Vec<ModelEntry>> {
    // Run `ollama list` with a 5s timeout. The child handle is kept on the
    // outer thread so we can kill it on timeout — the reader thread then
    // exits naturally because stdout closes. This prevents zombie ollama
    // processes and leaked OS threads on a hung daemon.
    use parking_lot::Mutex as PLMutex;
    use std::process::Stdio;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    let mut spawned = std::process::Command::new("ollama")
        .arg("list")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("ollama not found on PATH")?;

    // Capture the pid up front so the timeout path can SIGKILL the child WITHOUT
    // taking the same lock the reader thread holds for the entire duration of
    // wait(). Locking it here would deadlock: the reader is parked inside
    // wait() holding the mutex until the daemon exits, so the timeout's kill()
    // would block on child.lock() and never fire against a genuinely hung
    // process — defeating the kill-on-timeout design. (low-severity bug fix)
    let pid = spawned.id();
    let stdout = spawned.stdout.take();
    let child = Arc::new(PLMutex::new(spawned));
    let (tx, rx) = mpsc::channel::<Result<(std::process::ExitStatus, String)>>();
    let child_for_reader = child.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        if let Some(mut s) = stdout {
            let _ = s.read_to_string(&mut buf);
        }
        let status = child_for_reader.lock().wait();
        let _ = tx.send(status.map(|s| (s, buf)).map_err(|e| e.into()));
    });

    let (exit_status, stdout_buf) = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(r) => r?,
        Err(_) => {
            // Kill the hung child by pid so the reader thread can drain and
            // exit. We deliberately do NOT take child.lock() here — the reader
            // may be holding it inside wait() (see comment above). SIGKILL by
            // pid is safe because the pid is still live (the reader hasn't
            // reaped it yet); the reader's own wait() then reaps the zombie.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            return Err(anyhow::anyhow!("ollama list timed out after 5s"));
        }
    };
    if !exit_status.success() {
        return Err(anyhow::anyhow!("ollama list exited with {exit_status}"));
    }
    let mut out = Vec::new();
    for line in stdout_buf.lines().skip(1) {
        // Columns: NAME  ID  SIZE_NUM  SIZE_UNIT  MODIFIED...
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let _ = parts.next(); // ID
        let size_num: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let size_unit = parts.next().unwrap_or("B");
        let size_bytes = match size_unit {
            "GB" => (size_num * 1_000_000_000.0) as u64,
            "MB" => (size_num * 1_000_000.0) as u64,
            "KB" => (size_num * 1_000.0) as u64,
            _ => size_num as u64,
        };
        out.push(ModelEntry {
            id: name.to_string(),
            size_bytes,
            backend: "ollama".into(),
        });
    }
    Ok(out)
}

pub struct ModelLists {
    pub mlx: Vec<ModelEntry>,
    pub ollama: Vec<ModelEntry>,
    pub mlx_error: Option<String>,
    pub ollama_error: Option<String>,
}

/// Authoritative, backend-reported model facts (item 2). All fields optional:
/// the caller falls back to the name heuristic for anything we couldn't learn.
#[derive(Serialize, Clone, Default)]
pub struct ModelMetadata {
    /// True context window in tokens (Ollama `/api/show` arch context_length,
    /// or HF `config.json` `max_position_embeddings`), or None if unknown.
    pub context_length: Option<u64>,
    /// Whether the model accepts images, when the backend declares it
    /// (Ollama capabilities array contains "vision", or the HF config has a
    /// vision sub-config / multimodal model_type). None = couldn't determine.
    pub vision: Option<bool>,
    /// Which authority answered: "ollama", "mlx-config", "native-config",
    /// or "none". Diagnostic only.
    pub source: String,
}

/// Resolve a model's real context length + vision capability from the backend
/// itself rather than a name regex (item 2). `backend` is "ollama", "mlx", or
/// "native". Best-effort: returns `Default` (all-None) when nothing is knowable
/// so the frontend keeps its heuristic. Never errors — an unreachable daemon or
/// missing config just yields None.
pub fn model_metadata(model: &str, backend: &str) -> ModelMetadata {
    match backend {
        "ollama" => ollama_show_metadata(model).unwrap_or_default(),
        "mlx" => hf_config_metadata(model)
            .map(|mut m| {
                m.source = "mlx-config".into();
                m
            })
            .unwrap_or_default(),
        "native" => hf_config_metadata(model)
            .map(|mut m| {
                m.source = "native-config".into();
                m
            })
            .unwrap_or_default(),
        _ => ModelMetadata::default(),
    }
}

/// Query Ollama's `/api/show` for the authoritative context length + vision
/// capability of one model. The arch-prefixed `<arch>.context_length` key in
/// `model_info` is the architectural window; a Modelfile `num_ctx` parameter
/// (if present) is what the model is actually RUN with, so it wins. The
/// top-level `capabilities` array carries "vision" for multimodal models.
fn ollama_show_metadata(model: &str) -> Option<ModelMetadata> {
    use std::time::Duration;

    #[derive(serde::Deserialize)]
    struct ShowResponse {
        #[serde(default)]
        model_info: serde_json::Map<String, serde_json::Value>,
        #[serde(default)]
        parameters: Option<String>,
        #[serde(default)]
        capabilities: Option<Vec<String>>,
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .post(format!("{OLLAMA_API_BASE}/api/show"))
        .json(&serde_json::json!({ "name": model }))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let parsed: ShowResponse = resp.json().ok()?;

    // Context: prefer the Modelfile `num_ctx` (the active window), else the
    // architectural `*.context_length`.
    let mut context_length: Option<u64> = None;
    if let Some(params) = parsed.parameters.as_deref() {
        for line in params.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("num_ctx") {
                if let Ok(n) = rest.trim().parse::<u64>() {
                    if n > 0 {
                        context_length = Some(n);
                    }
                }
            }
        }
    }
    if context_length.is_none() {
        for (k, v) in &parsed.model_info {
            if k.ends_with(".context_length") {
                if let Some(n) = v.as_u64() {
                    if n > 0 {
                        context_length = Some(n);
                        break;
                    }
                }
            }
        }
    }

    let vision = parsed
        .capabilities
        .map(|caps| caps.iter().any(|c| c.eq_ignore_ascii_case("vision")));

    Some(ModelMetadata {
        context_length,
        vision,
        source: "ollama".into(),
    })
}

/// Read an MLX/native model's `config.json` from the HF hub cache and extract
/// the real context window + a vision hint. `max_position_embeddings` is the
/// canonical context field; a `vision_config` sub-object or a multimodal
/// `model_type` flags vision support. Returns None when the model isn't a
/// cached HF repo (e.g. a bare GGUF path) or has no readable config.
fn hf_config_metadata(repo_id: &str) -> Option<ModelMetadata> {
    let config = read_hf_config(repo_id)?;
    Some(metadata_from_hf_config(&config))
}

/// Pure transform: derive context length + vision from a parsed HF
/// `config.json` object. Split out from the fs read so it's unit-testable.
fn metadata_from_hf_config(config: &serde_json::Map<String, serde_json::Value>) -> ModelMetadata {
    // Context: `max_position_embeddings` at the top level, or nested under a
    // `text_config` for multimodal models (their language tower holds it).
    let context_length = config
        .get("max_position_embeddings")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            config
                .get("text_config")
                .and_then(|t| t.get("max_position_embeddings"))
                .and_then(serde_json::Value::as_u64)
        })
        .filter(|n| *n > 0);

    // Vision: a `vision_config` sub-object, or a model_type / architectures
    // entry that names a known multimodal family.
    let has_vision_config = config.get("vision_config").is_some();
    let model_type = config
        .get("model_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let arch_str = config
        .get("architectures")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let multimodal_marker = ["vl", "vision", "llava", "image", "multimodal"]
        .iter()
        .any(|m| model_type.contains(m) || arch_str.contains(m));
    // We report a definite boolean because we actually parsed a real config:
    // a positive signal => true, otherwise false (so a text model's image
    // button is correctly hidden rather than left to the name heuristic).
    let vision = Some(has_vision_config || multimodal_marker);

    ModelMetadata {
        context_length,
        vision,
        source: String::new(), // set by caller (mlx-config / native-config)
    }
}

/// Locate and parse a cached HF repo's `config.json`. The repo lives at
/// `<hub>/models--<org>--<name>/snapshots/<rev>/config.json`; there may be
/// several snapshot revisions, so pick the most recently modified. Returns the
/// parsed JSON object, or None if the repo/config isn't present.
fn read_hf_config(repo_id: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    // Reject anything that isn't a clean org/name HF repo so we never build a
    // traversal path from a hostile id (defense in depth — ids are validated
    // upstream, but this fn is reachable from the metadata command).
    if repo_id.is_empty() || repo_id.contains("..") || repo_id.contains('\0') {
        return None;
    }
    let parts: Vec<&str> = repo_id.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let hub = hf_hub_dir();
    let encoded = format!("models--{}", repo_id.replace('/', "--"));
    let snapshots = hub.join(&encoded).join("snapshots");

    // Newest snapshot dir wins (a re-pull adds a new revision).
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&snapshots).ok()?.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
            best = Some((mtime, p));
        }
    }
    let snapshot = best?.1;
    let config_path = snapshot.join("config.json");
    let bytes = std::fs::read(&config_path).ok()?;
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

pub fn delete_mlx_model(repo_id: &str) -> Result<()> {
    if repo_id.is_empty() || repo_id.contains("..") || repo_id.contains('\0') {
        return Err(anyhow::anyhow!("invalid repo id"));
    }
    // Validate org/name shape (HF repo)
    let parts: Vec<&str> = repo_id.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(anyhow::anyhow!("repo id must be org/name"));
    }
    let hub = hf_hub_dir();
    let canon_hub = std::fs::canonicalize(&hub).context("HF hub directory not accessible")?;
    let encoded = format!("models--{}", repo_id.replace('/', "--"));
    let target = canon_hub.join(&encoded);
    // Canonicalize the target itself and re-check containment to defeat any
    // symlink in the encoded path.
    let canon_target =
        std::fs::canonicalize(&target).map_err(|e| anyhow::anyhow!("model dir not found: {e}"))?;
    if !canon_target.starts_with(&canon_hub) {
        return Err(anyhow::anyhow!("model path escapes hub root"));
    }
    std::fs::remove_dir_all(&canon_target).context("failed to remove model directory")?;
    DIR_SIZE_CACHE.lock().remove(&target);
    Ok(())
}

pub fn delete_ollama_model(name: &str) -> Result<()> {
    use std::process::Stdio;
    let output = std::process::Command::new("ollama")
        .arg("rm")
        // `--` end-of-options guard, matching the pull path. The name is
        // already charset-validated upstream, but this keeps `rm` symmetric
        // with `pull` so a future validator loosening can't make a
        // flag-like name injectable here. LOW (2026-05-29).
        .arg("--")
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("ollama not found on PATH")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("ollama rm failed: {}", stderr.trim()));
    }
    Ok(())
}

pub fn list_all_models() -> Result<ModelLists> {
    let (mlx, mlx_error) = match list_mlx_models() {
        Ok(v) => (v, None),
        Err(e) => (vec![], Some(e.to_string())),
    };
    let (ollama, ollama_error) = match list_ollama_models() {
        Ok(v) => (v, None),
        Err(e) => (vec![], Some(e.to_string())),
    };
    Ok(ModelLists {
        mlx,
        ollama,
        mlx_error,
        ollama_error,
    })
}

fn hf_hub_dir() -> PathBuf {
    if let Ok(p) = std::env::var("HF_HOME") {
        return PathBuf::from(p).join("hub");
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".cache/huggingface/hub")
}

fn cached_dir_size(path: &Path) -> Result<u64> {
    // Bug (low): a model dir's top-level mtime only moves when its direct
    // entries (blobs/ snapshots/ refs/) are added/removed — NOT when HF writes
    // new/larger blobs *inside* those existing subdirs on a re-pull, a new
    // revision, or a partial download completing. Keying solely on the top-dir
    // mtime returns the stale first-seen size forever. Fold in the `blobs/`
    // mtime (where weights actually land) so the cache key advances when the
    // on-disk size really changes.
    let mtime = dir_size_cache_key(path);
    if let Some(mt) = mtime {
        let mut cache = DIR_SIZE_CACHE.lock();
        if let Some((cached_mt, size)) = cache.get(path) {
            if *cached_mt == mt {
                return Ok(*size);
            }
        }
        let size = dir_size(path).unwrap_or(0);
        cache.insert(path.to_path_buf(), (mt, size));
        Ok(size)
    } else {
        dir_size(path)
    }
}

/// Cache-invalidation key for a `models--*` dir: the max of the top-level dir
/// mtime and the `blobs/` subdir mtime. New blobs land in `blobs/`, bumping its
/// mtime even when the parent's direct entries are unchanged, so this advances
/// whenever the model's real size grows.
fn dir_size_cache_key(path: &Path) -> Option<SystemTime> {
    let top = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let blobs = std::fs::metadata(path.join("blobs"))
        .and_then(|m| m.modified())
        .ok();
    Some(match blobs {
        Some(b) if b > top => b,
        _ => top,
    })
}

fn dir_size(path: &Path) -> Result<u64> {
    // Resolve the root once so symlinks pointing outside the model directory
    // are not followed. HF snapshots contain symlinks into the blob store
    // (same root, different subtree) — we resolve those and check containment.
    let root = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    // Best-effort walk (low-severity bug fix): a single unreadable entry
    // (permission error, a file/dir removed mid-walk by a concurrent HF
    // pull/GC, a broken mount) must NOT abort the whole walk via `?` and
    // collapse the model's size to 0. Skip the offending entry and keep
    // accumulating so we report a slightly-low total instead of zero.
    while let Some(p) = stack.pop() {
        let Ok(md) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if md.file_type().is_symlink() {
            // Resolve the symlink; only follow if it stays inside the model root
            // and points to a regular file. Skip directories to avoid loops.
            if let Ok(target) = std::fs::canonicalize(&p) {
                if target.starts_with(&root) {
                    if let Ok(tmd) = std::fs::metadata(&target) {
                        if tmd.is_file() {
                            total += tmd.len();
                        }
                    }
                }
            }
            continue;
        }
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for entry in rd.flatten() {
                    stack.push(entry.path());
                }
            }
        } else {
            total += md.len();
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_mlx_rejects_invalid_repo_ids() {
        for bad in [
            "",
            "noslash",
            "..",
            "../escape",
            "org/../name",
            "org/name/extra",
            "/absolute/path",
            "org/name\0",
        ] {
            let r = delete_mlx_model(bad);
            assert!(r.is_err(), "expected rejection for {bad:?}");
        }
    }

    #[test]
    fn delete_mlx_rejects_traversal_attempts() {
        // Even if the hub dir exists, these should fail validation before fs ops.
        for malicious in ["..//..//etc", "a/..", ".."] {
            assert!(delete_mlx_model(malicious).is_err());
        }
    }

    fn obj(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        match v {
            serde_json::Value::Object(m) => m,
            _ => panic!("expected object"),
        }
    }

    #[test]
    fn hf_config_reads_context_and_vision() {
        // Plain text model: context from max_position_embeddings, no vision.
        let m = metadata_from_hf_config(&obj(serde_json::json!({
            "model_type": "llama",
            "max_position_embeddings": 131072,
            "architectures": ["LlamaForCausalLM"],
        })));
        assert_eq!(m.context_length, Some(131072));
        assert_eq!(m.vision, Some(false));

        // Multimodal via vision_config sub-object → vision true; context can
        // live under text_config.
        let mm = metadata_from_hf_config(&obj(serde_json::json!({
            "model_type": "qwen2_vl",
            "vision_config": { "depth": 32 },
            "text_config": { "max_position_embeddings": 32768 },
        })));
        assert_eq!(mm.context_length, Some(32768));
        assert_eq!(mm.vision, Some(true));

        // Vision flagged purely by model_type marker.
        let llava = metadata_from_hf_config(&obj(serde_json::json!({
            "model_type": "llava",
            "max_position_embeddings": 4096,
        })));
        assert_eq!(llava.vision, Some(true));
    }

    #[test]
    fn hf_config_zero_context_is_none() {
        // A 0 / missing window must report None, never a budget of 0.
        let z = metadata_from_hf_config(&obj(serde_json::json!({
            "model_type": "phi3",
            "max_position_embeddings": 0,
        })));
        assert_eq!(z.context_length, None);
        let empty = metadata_from_hf_config(&obj(serde_json::json!({})));
        assert_eq!(empty.context_length, None);
        assert_eq!(empty.vision, Some(false));
    }

    #[test]
    fn read_hf_config_rejects_bad_repo_ids() {
        // Traversal / non-repo ids must never build an fs path.
        for bad in [
            "",
            "noslash",
            "..",
            "../escape",
            "org/../name",
            "org/name\0",
        ] {
            assert!(read_hf_config(bad).is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn model_metadata_unknown_backend_is_empty() {
        let m = model_metadata("whatever", "openrouter");
        assert_eq!(m.context_length, None);
        assert_eq!(m.vision, None);
        assert_eq!(m.source, "");
    }
}
