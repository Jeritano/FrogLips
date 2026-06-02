//! GGUF file picker / downloader plumbing.
//!
//! The HuggingFace tab in `ModelBrowser` is pinned to `mlx-community/*` and
//! pulls *entire repos* via the `huggingface-cli` shell-out. These commands
//! instead fetch a *single* `.gguf` file from any repo. The commands here let
//! the frontend:
//!
//!   * stream a one-off file download with resumable Range requests +
//!     per-byte progress events,
//!   * list everything we've previously downloaded into the local cache, and
//!   * delete a specific cached GGUF (two-click confirm pattern lives in the
//!     UI; the backend just enforces the path-safety invariants).
//!
//! The cache root lives under the app's `app_data_dir` (on macOS:
//! `~/Library/Application Support/com.joseph.froglips/models/gguf/`). Each
//! repo gets its own subdir named `{org}_{name}` so the on-disk shape is
//! flat and safe to enumerate without parsing HF's `models--*` scheme.
//!
//! ## Security invariants
//! Every path that touches the filesystem is composed from sanitized repo +
//! filename strings and then canonicalized; the canonical form MUST start
//! with the canonical cache root. Repo strings may only contain
//! `[A-Za-z0-9._-]` per segment (HF's own validator), filenames must end in
//! `.gguf` and contain no path separators or `..`. These checks are unit
//! tested at the bottom of this file.

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

/// `O_NOFOLLOW` open flag, kept in sync with `agent::fs`. We avoid a
/// direct `libc` dep — the values match the platforms' `<fcntl.h>`:
///   - macOS / BSDs: 0x0100
///   - Linux:        0o400000 (0x20000)
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
))]
const O_NOFOLLOW: i32 = 0x0100;
#[cfg(target_os = "linux")]
const O_NOFOLLOW: i32 = 0o400000;

/// Maximum length of an HF repo id ("org/name"). Mirrors what HF itself
/// accepts in their URL routing; anything longer is almost certainly a
/// crafted input.
const MAX_REPO_LEN: usize = 128;
/// Maximum length of a single filename inside the repo tree. HF caps at
/// ~255 (POSIX NAME_MAX) but GGUF filenames in the wild stay well under
/// 128, so we cap aggressively to keep the validation cheap.
const MAX_FILENAME_LEN: usize = 200;

/// Inflight-download set keyed by `{repo_safe}/{filename}`. Prevents
/// double-clicking the download button from racing two HTTP streams onto
/// the same file. Released in a `Drop` guard so panics still clear.
static INFLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

struct InflightGuard {
    key: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        INFLIGHT.lock().remove(&self.key);
    }
}

/// Acquire the inflight slot for `key`. Returns `Err` if another download
/// for the same file is already running.
fn acquire_inflight(key: String) -> Result<InflightGuard> {
    let mut g = INFLIGHT.lock();
    if g.contains(&key) {
        return Err(anyhow!("download already in progress for {key}"));
    }
    g.insert(key.clone());
    Ok(InflightGuard { key })
}

/// One cached GGUF file on disk. Surfaces what the UI needs to render
/// the "Installed (GGUF)" section.
#[derive(Debug, Serialize, Clone)]
pub struct GgufFile {
    /// Original HF repo id, reconstructed from the sanitized dir name.
    pub repo: String,
    pub filename: String,
    /// Absolute path — caller passes this straight to `native_load_model`.
    pub path: String,
    pub size_bytes: u64,
    /// Unix mtime in seconds. Used for "newest first" sort in the UI.
    pub mtime: u64,
}

/// Validate an HF repo id ("org/name" or "org/name/subpath/...").
/// Mirrors `validate_hf_repo` in lib.rs, but lives here so the gguf
/// module is self-contained and unit-testable without the broader
/// lib.rs surface.
pub fn validate_repo(repo: &str) -> Result<()> {
    if repo.is_empty() || repo.len() > MAX_REPO_LEN {
        return Err(anyhow!("repo length out of range"));
    }
    if repo.starts_with('-') || repo.contains("..") || repo.contains('\0') {
        return Err(anyhow!("repo must not start with '-' or contain '..'"));
    }
    if repo.starts_with('/') || repo.starts_with('\\') {
        return Err(anyhow!("repo must not start with a path separator"));
    }
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err(anyhow!("repo id must be org/name"));
    }
    for seg in &parts {
        // HF allows letters, digits, dots, dashes, underscores.
        for ch in seg.chars() {
            if !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_') {
                return Err(anyhow!("repo segment contains illegal character: {ch:?}"));
            }
        }
        if !seg.chars().any(|c| c.is_ascii_alphanumeric()) {
            return Err(anyhow!("repo segments must contain alphanumerics"));
        }
    }
    Ok(())
}

/// Validate a GGUF filename. Must end in `.gguf`, must NOT contain any
/// path separator or `..`. Multi-part GGUFs (`name.Q4_K_M.gguf.part1of3`)
/// are rejected for now — we'll wire those up in a follow-up phase, the
/// llama.cpp loader handles them but the UX wants single-file pulls.
pub fn validate_filename(filename: &str) -> Result<()> {
    if filename.is_empty() || filename.len() > MAX_FILENAME_LEN {
        return Err(anyhow!("filename length out of range"));
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains('\0') {
        return Err(anyhow!("filename must not contain path separators"));
    }
    if filename.contains("..") {
        return Err(anyhow!("filename must not contain '..'"));
    }
    if filename.starts_with('.') {
        return Err(anyhow!("filename must not start with '.'"));
    }
    if !filename.to_ascii_lowercase().ends_with(".gguf") {
        return Err(anyhow!("filename must end with .gguf"));
    }
    Ok(())
}

/// Sanitize a repo id for use as a filesystem directory name. Replaces
/// `/` with `_` — every other character is already restricted by
/// `validate_repo`, so the result is guaranteed to be a single safe
/// path component.
pub fn repo_to_dir(repo: &str) -> String {
    repo.replace('/', "_")
}

/// Reverse `repo_to_dir`: turn `org_name` back into `org/name`. Best-effort
/// — if the dir name contains zero underscores we return it unchanged.
/// HF org+name segments cannot themselves contain `/`, but they CAN contain
/// `_`, so we split only on the FIRST underscore (HF orgs never have an
/// underscore? Some do — e.g. an org id like `some_org`). To be safe we keep the original
/// dir name as a fallback identifier when there's ambiguity; the UI just
/// shows whatever this returns and never round-trips through file lookups.
fn dir_to_repo(dir: &str) -> String {
    // Heuristic: split at the LAST underscore, since HF model names also
    // frequently contain underscores. Neither direction is perfectly
    // recoverable; downstream consumers should treat this as a display
    // hint only.
    if let Some(idx) = dir.rfind('_') {
        let (org, name) = dir.split_at(idx);
        let name = &name[1..]; // strip the underscore
        if !org.is_empty() && !name.is_empty() {
            return format!("{org}/{name}");
        }
    }
    dir.to_string()
}

/// Cache root directory: `{app_data_dir}/models/gguf/`.
///
/// We accept `app_data_dir` from the caller so unit tests can substitute a
/// `tempdir`. In production the Tauri command resolves it via
/// `AppHandle::path().app_data_dir()`.
pub fn cache_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join("gguf")
}

/// Resolve the on-disk path for a given (repo, filename) and verify that
/// the canonicalized path is contained within the canonicalized cache
/// root. The directory portion is created if missing.
///
/// Returns `(target_file_path, canonicalized_cache_root)`. Callers that
/// have not yet written the file canonicalize the *parent* and check
/// containment manually — see [`download`] for the pattern.
pub fn resolve_target(app_data_dir: &Path, repo: &str, filename: &str) -> Result<PathBuf> {
    validate_repo(repo)?;
    validate_filename(filename)?;
    let root = cache_root(app_data_dir);
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create cache root {}", root.display()))?;
    let canon_root = std::fs::canonicalize(&root)
        .with_context(|| format!("failed to canonicalize cache root {}", root.display()))?;
    let repo_dir = canon_root.join(repo_to_dir(repo));
    std::fs::create_dir_all(&repo_dir)
        .with_context(|| format!("failed to create repo dir {}", repo_dir.display()))?;
    let canon_repo = std::fs::canonicalize(&repo_dir)
        .with_context(|| format!("failed to canonicalize repo dir {}", repo_dir.display()))?;
    if !canon_repo.starts_with(&canon_root) {
        return Err(anyhow!("repo dir escapes cache root"));
    }
    let target = canon_repo.join(filename);
    // Don't canonicalize the file yet — it may not exist. Containment of
    // its parent is sufficient because `filename` has no separators.
    if !target.starts_with(&canon_root) {
        return Err(anyhow!("target file escapes cache root"));
    }
    Ok(target)
}

/// Scan the local GGUF cache and return one entry per `.gguf` file found,
/// sorted newest-first by mtime.
pub fn list_files(app_data_dir: &Path) -> Result<Vec<GgufFile>> {
    let root = cache_root(app_data_dir);
    if !root.exists() {
        return Ok(vec![]);
    }
    let canon_root = std::fs::canonicalize(&root)
        .with_context(|| format!("failed to canonicalize cache root {}", root.display()))?;
    let mut out: Vec<GgufFile> = Vec::new();
    for repo_entry in std::fs::read_dir(&canon_root)? {
        let repo_entry = match repo_entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let repo_path = repo_entry.path();
        // Defence-in-depth: only walk regular dirs that live under the
        // canonicalized cache root.
        let canon = match std::fs::canonicalize(&repo_path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !canon.starts_with(&canon_root) {
            continue;
        }
        let md = match std::fs::metadata(&canon) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_dir() {
            continue;
        }
        let dir_name = repo_entry.file_name().to_string_lossy().into_owned();
        let repo_id = dir_to_repo(&dir_name);
        for f in std::fs::read_dir(&canon)?.flatten() {
            let p = f.path();
            let fmd = match std::fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !fmd.is_file() {
                continue;
            }
            let fname = f.file_name().to_string_lossy().into_owned();
            if !fname.to_ascii_lowercase().ends_with(".gguf") {
                continue;
            }
            let mtime = fmd
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(GgufFile {
                repo: repo_id.clone(),
                filename: fname,
                path: p.to_string_lossy().into_owned(),
                size_bytes: fmd.len(),
                mtime,
            });
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    Ok(out)
}

/// Startup sweep: remove abandoned `*.gguf.part` files from interrupted
/// downloads. Safe to call only at startup — a fresh process has no download
/// in flight, so every `.part` is orphaned (a resumable retry re-creates it).
/// Best-effort; never follows symlinks; returns the count removed.
/// LOW (2026-05-30).
pub fn cleanup_orphan_part_files(app_data_dir: &Path) -> usize {
    let Ok(canon_root) = std::fs::canonicalize(cache_root(app_data_dir)) else {
        return 0; // cache never created → nothing to sweep
    };
    let mut removed = 0usize;
    let Ok(repos) = std::fs::read_dir(&canon_root) else {
        return 0;
    };
    for repo in repos.flatten() {
        let canon = match std::fs::canonicalize(repo.path()) {
            Ok(p) if p.starts_with(&canon_root) && p.is_dir() => p,
            _ => continue,
        };
        let Ok(files) = std::fs::read_dir(&canon) else {
            continue;
        };
        for f in files.flatten() {
            if !f
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".gguf.part")
            {
                continue;
            }
            // Regular files only — never unlink through a symlink.
            let p = f.path();
            let is_regular = std::fs::symlink_metadata(&p)
                .map(|md| md.is_file())
                .unwrap_or(false);
            if is_regular && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Delete a single cached GGUF. Path-safety identical to `resolve_target`.
pub fn delete_file(app_data_dir: &Path, repo: &str, filename: &str) -> Result<()> {
    let target = resolve_target(app_data_dir, repo, filename)?;
    // Final canonicalize-and-check to defeat any symlink at the leaf.
    let canon_target = std::fs::canonicalize(&target)
        .with_context(|| format!("file not found: {}", target.display()))?;
    let canon_root = std::fs::canonicalize(cache_root(app_data_dir))?;
    if !canon_target.starts_with(&canon_root) {
        return Err(anyhow!("target escapes cache root"));
    }
    let md = std::fs::symlink_metadata(&canon_target)?;
    if !md.is_file() {
        return Err(anyhow!("refusing to delete non-regular file"));
    }
    std::fs::remove_file(&canon_target).context("remove_file failed")?;
    Ok(())
}

/// Construct the canonical HuggingFace direct-download URL for a file.
/// Using `/resolve/main/` (NOT `/raw/main/`) follows LFS redirects, which
/// is what we need for >100 MB GGUF blobs.
fn hf_download_url(repo: &str, filename: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{filename}")
}

/// Progress event payload emitted as `gguf-download-progress` while a
/// download is running. Throttled to ~10 Hz by the caller.
#[derive(Debug, Serialize, Clone)]
pub struct GgufProgress {
    pub repo: String,
    pub filename: String,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
}

/// Stream-download a single GGUF file from HF, emitting `gguf-download-progress`
/// events on `app`. Supports resume via `Range` if a partial file exists.
///
/// Returns the absolute destination path on success.
pub async fn download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    app_data_dir: PathBuf,
    repo: String,
    filename: String,
) -> Result<PathBuf> {
    let target = resolve_target(&app_data_dir, &repo, &filename)?;
    // MED (2026-05-30): stream into a `.part` sidecar and only rename to the
    // final `.gguf` once the full body has landed and its length verified.
    // Writing straight to the final name left a TRUNCATED `.gguf` on any
    // interrupted download — and `list_files` reported it as an installed
    // model, so the user could try to load a corrupt file. `.part` is ignored
    // by `list_files` (it doesn't end in `.gguf`) and doubles as the resume
    // buffer.
    let part = {
        let mut p = target.clone().into_os_string();
        p.push(".part");
        PathBuf::from(p)
    };

    // Inflight guard — one download at a time per (repo, filename).
    let key = format!("{}/{}", repo_to_dir(&repo), filename);
    let _guard = acquire_inflight(key)?;

    // Resume: if a partial `.part` exists, send Range: bytes=N-.
    let existing = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let url = hf_download_url(&repo, &filename);
    let client = reqwest::Client::builder()
        .user_agent("froglips-gguf-downloader/0.1")
        // 30-min absolute cap. Within that window, reqwest will stream
        // bytes as they arrive — there's no per-chunk timeout.
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .context("reqwest client build failed")?;
    let mut req = client.get(&url);
    if existing > 0 {
        req = req.header("Range", format!("bytes={existing}-"));
    }
    let resp = req.send().await.context("HF GET failed")?;

    let status = resp.status();
    // 200 = full body, 206 = partial (resume succeeded). Everything else
    // is treated as a failure — including 416 (resume past EOF), which
    // typically means our `existing` is larger than the remote file and
    // we should restart from scratch.
    if !(status.is_success() || status.as_u16() == 206) {
        // 416 (Range Not Satisfiable) means our `.part` is at least as large
        // as the remote file — usually a stale/corrupt partial. Delete it so
        // the next attempt restarts cleanly instead of looping on 416.
        if status.as_u16() == 416 {
            let _ = std::fs::remove_file(&part);
        }
        return Err(anyhow!("HF returned status {status}"));
    }
    let resuming = status.as_u16() == 206 && existing > 0;
    let content_len = resp.content_length().unwrap_or(0);
    let total = if resuming {
        existing + content_len
    } else {
        content_len
    };

    // Stream the body to disk. Open in append mode when resuming so we
    // don't truncate the head we already have.
    //
    // `O_NOFOLLOW` closes the TOCTOU at the leaf: `resolve_target` already
    // canonicalized the cache root and verified containment, and the
    // inflight guard prevents two of OUR tasks from racing — but a
    // *separate* process (or a hostile workflow on the same cache) could
    // still swap the cache file for a symlink after the guard acquires.
    // With `O_NOFOLLOW`, the kernel refuses to open through a symlink at
    // the final path component, so the write can never escape the cache.
    let mut open_opts = tokio::fs::OpenOptions::new();
    open_opts
        .create(true)
        .write(true)
        .truncate(!resuming)
        .append(resuming);
    #[cfg(unix)]
    {
        open_opts.custom_flags(O_NOFOLLOW);
    }
    let mut file = open_opts
        .open(&part)
        .await
        .with_context(|| format!("open {} for write", part.display()))?;

    let mut downloaded: u64 = if resuming { existing } else { 0 };
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read body chunk failed")?;
        file.write_all(&chunk).await.context("write chunk failed")?;
        downloaded += chunk.len() as u64;
        // Throttle progress to ~10 Hz so we don't flood the IPC channel.
        if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            let _ = app.emit(
                "gguf-download-progress",
                GgufProgress {
                    repo: repo.clone(),
                    filename: filename.clone(),
                    bytes_downloaded: downloaded,
                    total_bytes: total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    file.flush().await.context("flush failed")?;
    drop(file);

    // Completeness gate: when the server told us THIS response's body length,
    // refuse to publish a short file (a cleanly-closed-but-premature stream
    // wouldn't surface as a chunk error). The `.part` survives for resume.
    //
    // Gate on `content_len` (this response's advertised length), NOT `total`:
    // a 206 resume can omit Content-Length (chunked), in which case
    // `content_len == 0` and `total` collapses to `existing` — comparing
    // against that would false-fail a download that actually completed past
    // the resume offset. When the length is unknown we can't verify, so we
    // accept and publish. (2026-05-30)
    if content_len > 0 && downloaded != total {
        return Err(anyhow!(
            "incomplete download: got {downloaded} of {total} bytes (partial kept for resume)"
        ));
    }

    // Publish atomically: rename the verified `.part` over the final name.
    tokio::fs::rename(&part, &target)
        .await
        .with_context(|| format!("finalize {} -> {}", part.display(), target.display()))?;

    // Final progress: ensures the UI sees the terminal frame even if the
    // last chunk landed inside the 100ms throttle window.
    let _ = app.emit(
        "gguf-download-progress",
        GgufProgress {
            repo: repo.clone(),
            filename: filename.clone(),
            bytes_downloaded: downloaded,
            total_bytes: if total > 0 { total } else { downloaded },
        },
    );

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reject every shape of filename input that could escape the cache
    /// dir or trick us into writing a non-GGUF.
    #[test]
    fn filename_validation_rejects_unsafe_inputs() {
        // Empty / overlong
        assert!(validate_filename("").is_err());
        let huge = "a".repeat(MAX_FILENAME_LEN + 1) + ".gguf";
        assert!(validate_filename(&huge).is_err());

        // Path traversal
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("../escape.gguf").is_err());
        assert!(validate_filename("..gguf").is_err()); // starts with '.'
        assert!(validate_filename("foo/../bar.gguf").is_err());

        // Path separators
        assert!(validate_filename("sub/dir.gguf").is_err());
        assert!(validate_filename("a\\b.gguf").is_err());
        assert!(validate_filename("/abs.gguf").is_err());

        // Null byte
        assert!(validate_filename("foo\0.gguf").is_err());

        // Wrong extension
        assert!(validate_filename("model.bin").is_err());
        assert!(validate_filename("README.md").is_err());
        assert!(validate_filename("model").is_err());

        // Hidden file
        assert!(validate_filename(".hidden.gguf").is_err());

        // Happy paths
        validate_filename("Llama-3.2-3B-Instruct.Q4_K_M.gguf").unwrap();
        validate_filename("model.GGUF").unwrap(); // case-insensitive ext
    }

    #[test]
    fn repo_validation_rejects_unsafe_inputs() {
        // Empty / shape
        assert!(validate_repo("").is_err());
        assert!(validate_repo("noslash").is_err());
        assert!(validate_repo("a/b/c").is_err());
        assert!(validate_repo("/abs/path").is_err());
        assert!(validate_repo("a//b").is_err());

        // Path traversal
        assert!(validate_repo("..").is_err());
        assert!(validate_repo("a/..").is_err());
        assert!(validate_repo("../etc/passwd").is_err());

        // Leading dash
        assert!(validate_repo("-evil/name").is_err());

        // Illegal chars
        assert!(validate_repo("org name/foo").is_err()); // space
        assert!(validate_repo("org/foo$bar").is_err());
        assert!(validate_repo("org\0/name").is_err());

        // Segments must contain alphanumerics — pure-punct rejected.
        assert!(validate_repo("---/---").is_err());

        // Happy paths
        validate_repo("mlx-community/Llama-3.2-3B-Instruct-4bit").unwrap();
        validate_repo("some_org/Qwen3-Coder-30B").unwrap();
        validate_repo("TheBloke/Llama-2-7B-GGUF").unwrap();
    }

    /// Build a fake app_data_dir in a temp directory and verify that
    /// `resolve_target` enforces containment for every craftable input
    /// shape. This is the load-bearing security test — if it ever
    /// regresses, the file picker can be tricked into writing outside
    /// the cache.
    #[test]
    fn resolve_target_contains_within_cache_root() {
        // Use a unique temp dir keyed by PID+nanos so parallel tests don't
        // collide. We avoid pulling in a `tempfile` crate dep since the
        // rest of the codebase doesn't use it.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let app_data = std::env::temp_dir().join(format!(
            "froglips-gguf-test-{}-{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&app_data).unwrap();

        // Happy path: a valid repo + filename resolves inside the cache root.
        let p = resolve_target(&app_data, "mlx-community/Foo-GGUF", "model.Q4_K_M.gguf")
            .expect("valid inputs must resolve");
        let cache = cache_root(&app_data);
        let canon_cache = std::fs::canonicalize(&cache).unwrap();
        assert!(
            p.starts_with(&canon_cache),
            "target {p:?} must start with cache root {canon_cache:?}",
        );

        // Filename traversal still blocked even with valid repo.
        assert!(resolve_target(&app_data, "mlx-community/Foo", "../escape.gguf").is_err());
        assert!(resolve_target(&app_data, "mlx-community/Foo", "sub/model.gguf").is_err());

        // Repo traversal blocked even with valid filename.
        assert!(resolve_target(&app_data, "..", "model.gguf").is_err());
        assert!(resolve_target(&app_data, "a/..", "model.gguf").is_err());
        assert!(resolve_target(&app_data, "../etc", "model.gguf").is_err());

        // Wrong extension blocked.
        assert!(resolve_target(&app_data, "mlx-community/Foo", "model.bin").is_err());

        // Clean up — best effort, ignore failures.
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn repo_dir_roundtrip_preserves_safe_names() {
        // Slash → underscore is reversible for the common "org/name" shape
        // when neither side contains an underscore.
        assert_eq!(
            repo_to_dir("mlx-community/Foo-GGUF"),
            "mlx-community_Foo-GGUF"
        );
        // Reverse: best-effort. We split on the last underscore so names
        // with multiple underscores still come out reasonably.
        assert_eq!(
            dir_to_repo("mlx-community_Foo-GGUF"),
            "mlx-community/Foo-GGUF"
        );
    }

    #[test]
    fn hf_download_url_uses_resolve_main() {
        // `/resolve/main/` is the LFS-aware route. If this ever flips to
        // `/raw/` we'll silently truncate large files at 100MB.
        let u = hf_download_url("mlx-community/Foo", "model.Q4_K_M.gguf");
        assert_eq!(
            u,
            "https://huggingface.co/mlx-community/Foo/resolve/main/model.Q4_K_M.gguf"
        );
    }

    #[test]
    fn inflight_guard_blocks_double_acquire() {
        let key = format!("inflight-test-{}", std::process::id());
        let g1 = acquire_inflight(key.clone()).expect("first acquire");
        let g2 = acquire_inflight(key.clone());
        assert!(g2.is_err(), "second acquire must fail while g1 is alive");
        drop(g1);
        let g3 = acquire_inflight(key).expect("acquire succeeds after drop");
        drop(g3);
    }
}
