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
        out.push(ModelEntry { id, size_bytes, backend: "mlx".into() });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn list_ollama_models() -> Result<Vec<ModelEntry>> {
    // Run `ollama list` with a 5s timeout. The child handle is kept on the
    // outer thread so we can kill it on timeout — the reader thread then
    // exits naturally because stdout closes. This prevents zombie ollama
    // processes and leaked OS threads on a hung daemon.
    use parking_lot::Mutex as PLMutex;
    use std::process::Stdio;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    let child = Arc::new(PLMutex::new(
        std::process::Command::new("ollama")
            .arg("list")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("ollama not found on PATH")?,
    ));

    let stdout = child.lock().stdout.take();
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
            // Kill the hung child so the reader thread can drain and exit
            let mut c = child.lock();
            let _ = c.kill();
            let _ = c.wait();
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
        let size_num: f64 = parts.next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
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
    let canon_hub = std::fs::canonicalize(&hub)
        .context("HF hub directory not accessible")?;
    let encoded = format!("models--{}", repo_id.replace('/', "--"));
    let target = canon_hub.join(&encoded);
    // Canonicalize the target itself and re-check containment to defeat any
    // symlink in the encoded path.
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| anyhow::anyhow!("model dir not found: {e}"))?;
    if !canon_target.starts_with(&canon_hub) {
        return Err(anyhow::anyhow!("model path escapes hub root"));
    }
    std::fs::remove_dir_all(&canon_target)
        .context("failed to remove model directory")?;
    DIR_SIZE_CACHE.lock().remove(&target);
    Ok(())
}

pub fn delete_ollama_model(name: &str) -> Result<()> {
    use std::process::Stdio;
    let output = std::process::Command::new("ollama")
        .arg("rm")
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
    Ok(ModelLists { mlx, ollama, mlx_error, ollama_error })
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
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
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

fn dir_size(path: &Path) -> Result<u64> {
    // Resolve the root once so symlinks pointing outside the model directory
    // are not followed. HF snapshots contain symlinks into the blob store
    // (same root, different subtree) — we resolve those and check containment.
    let root = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let md = std::fs::symlink_metadata(&p)?;
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
            for entry in std::fs::read_dir(&p)? {
                stack.push(entry?.path());
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
}
