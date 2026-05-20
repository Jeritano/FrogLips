use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::RwLock;
use std::time::Instant;

const MAX_READ_BYTES: usize = 65_536;
const MAX_SHELL_OUTPUT: usize = 32_768;
const SHELL_TIMEOUT_SECS: u64 = 30;
const MAX_PATH_LEN: usize = 4096;
const MAX_WRITE_BYTES: usize = 1_048_576;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_HITS: usize = 200;
const MAX_SEARCH_FILES_SCANNED: usize = 2000;
const MAX_GREP_LINE_BYTES: usize = 1024;

/* ── Workspace root (optional sandbox) ────────────────────────────────────── */

static WORKSPACE_ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_workspace_root(path: Option<String>) -> Result<Option<String>, String> {
    let normalized = match path {
        None => None,
        Some(p) if p.trim().is_empty() => None,
        Some(p) => {
            let expanded = expand_home(&p).map_err(|e| e.to_string())?;
            let canon = std::fs::canonicalize(&expanded)
                .map_err(|e| format!("workspace root invalid: {e}"))?;
            if !canon.is_dir() {
                return Err("workspace root must be a directory".into());
            }
            Some(canon)
        }
    };
    let display = normalized.as_ref().map(|p| p.to_string_lossy().into_owned());
    *WORKSPACE_ROOT.write().map_err(|_| "workspace lock poisoned")? = normalized;
    Ok(display)
}

pub fn get_workspace_root() -> Option<String> {
    WORKSPACE_ROOT
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.to_string_lossy().into_owned()))
}

fn workspace_root_clone() -> Option<PathBuf> {
    WORKSPACE_ROOT.read().ok().and_then(|g| g.clone())
}

/* ── Path validation w/ canonicalization + sandbox ─────────────────────────── */

fn expand_home(p: &str) -> Result<PathBuf> {
    if p.is_empty() || p.len() > MAX_PATH_LEN {
        return Err(anyhow!("path length invalid"));
    }
    if p.contains('\0') {
        return Err(anyhow!("path contains null byte"));
    }
    if let Some(rest) = p.strip_prefix("~/") {
        Ok(dirs::home_dir()
            .ok_or_else(|| anyhow!("home dir unavailable"))?
            .join(rest))
    } else if p == "~" {
        dirs::home_dir().ok_or_else(|| anyhow!("home dir unavailable"))
    } else {
        Ok(PathBuf::from(p))
    }
}

/// Resolves a user-supplied path. For existing paths, canonicalizes (follows
/// symlinks). For not-yet-existing paths (write targets), canonicalizes the
/// parent and joins the final component, then explicitly rejects `..` segments.
fn resolve_path(p: &str, must_exist: bool) -> Result<PathBuf> {
    let raw = expand_home(p)?;
    // Reject explicit `..` traversal in the source string outright — prevents
    // write-side path tricks even if the parent canonicalizes elsewhere.
    if raw.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(anyhow!("path may not contain '..'"));
    }
    if must_exist {
        std::fs::canonicalize(&raw).map_err(|e| anyhow!("path not accessible: {e}"))
    } else if let Ok(c) = std::fs::canonicalize(&raw) {
        Ok(c)
    } else if let Some(parent) = raw.parent() {
        let cparent = std::fs::canonicalize(parent)
            .map_err(|e| anyhow!("parent not accessible: {e}"))?;
        let name = raw
            .file_name()
            .ok_or_else(|| anyhow!("path has no file name"))?;
        Ok(cparent.join(name))
    } else {
        Err(anyhow!("path resolution failed"))
    }
}

fn home_prefixes() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for sub in [
            ".ssh",
            ".aws",
            ".config/gh",
            ".gnupg",
            "Library/Keychains",
            "Library/Cookies",
            "Library/Application Support/com.apple.TCC",
            "Library/Mail",
            "Library/Messages",
        ] {
            v.push(home.join(sub));
        }
    }
    v
}

fn protected_prefixes() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/System",
        "/private/etc",
        "/etc",
        "/private/var/db/sudo",
        "/var/db/sudo",
        "/Library/Keychains",
        "/Library/Application Support/com.apple.TCC",
        // App's own install path — don't let agent overwrite itself
        "/Applications/Froglips.app",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    v.extend(home_prefixes());
    v
}

fn is_protected_for_read(p: &Path) -> bool {
    let lossy = p.to_string_lossy();
    // Keychain + TCC database etc. blocked even for read
    let read_block: &[&str] = &[
        "/Library/Keychains",
        "/private/var/db/sudo",
        "/var/db/sudo",
        "/etc/sudoers",
        "/private/etc/sudoers",
    ];
    if read_block.iter().any(|r| lossy.starts_with(r)) {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        for sub in [
            ".ssh",
            ".gnupg",
            "Library/Keychains",
            "Library/Cookies",
            "Library/Application Support/com.apple.TCC",
        ] {
            if p.starts_with(home.join(sub)) {
                return true;
            }
        }
    }
    // Block .env-style files containing credentials
    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
        if name.starts_with(".env") || name == "credentials" || name == "credentials.json" {
            return true;
        }
    }
    false
}

fn is_protected_for_write(p: &Path) -> bool {
    if is_protected_for_read(p) {
        return true;
    }
    let prefixes = protected_prefixes();
    prefixes.iter().any(|pre| p.starts_with(pre))
}

fn within_workspace(p: &Path) -> bool {
    match workspace_root_clone() {
        None => true,
        Some(root) => p.starts_with(&root),
    }
}

/* ── Structured result types ──────────────────────────────────────────────── */

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolError {
    NotFound { message: String },
    PermissionDenied { message: String },
    Protected { message: String },
    OutsideWorkspace { message: String },
    InvalidArgument { message: String },
    TooLarge { message: String },
    Timeout { message: String },
    Io { message: String },
}

impl ToolError {
    fn invalid<S: Into<String>>(m: S) -> Self {
        ToolError::InvalidArgument { message: m.into() }
    }
    fn io<S: Into<String>>(m: S) -> Self {
        ToolError::Io { message: m.into() }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::NotFound { message }
            | ToolError::PermissionDenied { message }
            | ToolError::Protected { message }
            | ToolError::OutsideWorkspace { message }
            | ToolError::InvalidArgument { message }
            | ToolError::TooLarge { message }
            | ToolError::Timeout { message }
            | ToolError::Io { message } => write!(f, "{}", message),
        }
    }
}

fn err_string(e: ToolError) -> String {
    serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
}

fn classify_io(e: &std::io::Error) -> ToolError {
    use std::io::ErrorKind::*;
    let m = e.to_string();
    match e.kind() {
        NotFound => ToolError::NotFound { message: m },
        PermissionDenied => ToolError::PermissionDenied { message: m },
        _ => ToolError::io(m),
    }
}

fn validate_for_read(p: &str) -> Result<PathBuf, ToolError> {
    let resolved = resolve_path(p, true).map_err(|e| ToolError::invalid(e.to_string()))?;
    if is_protected_for_read(&resolved) {
        return Err(ToolError::Protected {
            message: "path is restricted".into(),
        });
    }
    if !within_workspace(&resolved) {
        return Err(ToolError::OutsideWorkspace {
            message: format!(
                "path is outside workspace root ({})",
                workspace_root_clone()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ),
        });
    }
    Ok(resolved)
}

fn validate_for_write(p: &str) -> Result<PathBuf, ToolError> {
    let resolved = resolve_path(p, false).map_err(|e| ToolError::invalid(e.to_string()))?;
    if is_protected_for_write(&resolved) {
        return Err(ToolError::Protected {
            message: "path is restricted for writes".into(),
        });
    }
    if !within_workspace(&resolved) {
        return Err(ToolError::OutsideWorkspace {
            message: "path is outside workspace root".into(),
        });
    }
    Ok(resolved)
}

/* ── DirEntry / list ─────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Serialize)]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/* ── Shell result ────────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/* ── Read file (w/ pagination) ───────────────────────────────────────────── */

#[derive(Serialize)]
pub struct ReadResult {
    pub content: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub truncated: bool,
}

pub async fn read_file(path: String, offset: Option<u64>, limit: Option<u64>) -> Result<ReadResult, String> {
    let resolved = validate_for_read(&path).map_err(err_string)?;
    let bytes = tokio::fs::read(&resolved).await.map_err(|e| err_string(classify_io(&e)))?;
    let total = bytes.len() as u64;
    let start = offset.unwrap_or(0).min(total);
    let cap = limit.unwrap_or(MAX_READ_BYTES as u64).min(MAX_READ_BYTES as u64);
    let end = (start + cap).min(total);
    let slice = &bytes[start as usize..end as usize];
    let truncated = end < total;
    let mut content = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        content.push_str(&format!(
            "\n[... bytes {}-{} of {} total]",
            start, end, total
        ));
    }
    Ok(ReadResult {
        content,
        bytes_read: end - start,
        total_bytes: total,
        truncated,
    })
}

/* ── List dir ────────────────────────────────────────────────────────────── */

pub async fn list_dir(path: String) -> Result<DirListing, String> {
    let resolved = validate_for_read(&path).map_err(err_string)?;
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut rd = tokio::fs::read_dir(&resolved)
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    let mut truncated = false;
    while let Some(e) = rd
        .next_entry()
        .await
        .map_err(|e| err_string(classify_io(&e)))?
    {
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let ft = match e.file_type().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let meta = e.metadata().await.ok();
        entries.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            kind: if ft.is_dir() {
                "dir"
            } else if ft.is_symlink() {
                "symlink"
            } else {
                "file"
            }
            .to_string(),
            size: meta.filter(|m| m.is_file()).map(|m| m.len()),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(DirListing { entries, truncated })
}

/* ── Run shell w/ cwd + env + duration ───────────────────────────────────── */

#[derive(Deserialize)]
pub struct ShellOpts {
    pub cwd: Option<String>,
    pub env: Option<Vec<(String, String)>>,
}

pub async fn run_shell(command: String, opts: Option<ShellOpts>) -> Result<ShellResult, String> {
    if command.is_empty() || command.len() > 4096 {
        return Err(err_string(ToolError::invalid("command length invalid")));
    }
    let opts = opts.unwrap_or(ShellOpts { cwd: None, env: None });

    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(&command);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    if let Some(c) = &opts.cwd {
        let resolved = validate_for_read(c).map_err(err_string)?;
        cmd.current_dir(resolved);
    } else if let Some(ws) = workspace_root_clone() {
        cmd.current_dir(ws);
    }
    if let Some(env) = &opts.env {
        for (k, v) in env {
            if k.contains(['\0', '=']) {
                return Err(err_string(ToolError::invalid("invalid env var name")));
            }
            cmd.env(k, v);
        }
    }

    let started = Instant::now();
    let timeout = std::time::Duration::from_secs(SHELL_TIMEOUT_SECS);
    let fut = cmd.output();
    let (output, timed_out) = match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(o)) => (o, false),
        Ok(Err(e)) => return Err(err_string(ToolError::io(e.to_string()))),
        Err(_) => {
            return Ok(ShellResult {
                stdout: String::new(),
                stderr: format!("timed out after {SHELL_TIMEOUT_SECS}s"),
                exit_code: -1,
                duration_ms: started.elapsed().as_millis() as u64,
                timed_out: true,
            });
        }
    };

    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stdout.len() > MAX_SHELL_OUTPUT {
        stdout.truncate(MAX_SHELL_OUTPUT);
        stdout.push_str("\n[truncated]");
    }
    if stderr.len() > MAX_SHELL_OUTPUT {
        stderr.truncate(MAX_SHELL_OUTPUT);
        stderr.push_str("\n[truncated]");
    }
    Ok(ShellResult {
        stdout,
        stderr,
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

/// Heuristic classifier for visibly destructive shell commands. Lets the
/// frontend show an extra-loud confirmation. Not a security boundary on its
/// own — user is still the final gate.
pub fn classify_shell_risk(command: &str) -> &'static str {
    let lc = command.to_lowercase();
    let patterns: &[&str] = &[
        "rm -rf /",
        "rm -rf ~",
        "rm -rf --no-preserve-root",
        ":(){:|:&};:",
        "mkfs",
        "dd of=/dev/",
        "shutdown",
        "reboot",
        "halt",
        "diskutil eraseDisk",
        "format /",
        "chown -r root",
        "chmod -r 777 /",
        "> /dev/sda",
    ];
    if patterns.iter().any(|p| lc.contains(p)) {
        return "destructive";
    }
    if lc.contains("curl ") && lc.contains("| sh") {
        return "pipe-from-network";
    }
    if lc.contains("sudo ") {
        return "privileged";
    }
    "normal"
}

/* ── Write file ──────────────────────────────────────────────────────────── */

pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = validate_for_write(&path).map_err(err_string)?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("content exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| err_string(classify_io(&e)))?;
    }
    tokio::fs::write(&resolved, content.as_bytes())
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    Ok(())
}

/* ── Edit file (patch-style replace) ──────────────────────────────────────── */

#[derive(Serialize)]
pub struct EditResult {
    pub replacements: u32,
    pub new_size: u64,
}

pub async fn edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<EditResult, String> {
    let resolved = validate_for_write(&path).map_err(err_string)?;
    if old_string.is_empty() {
        return Err(err_string(ToolError::invalid("old_string must not be empty")));
    }
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("file exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    let original = String::from_utf8(bytes).map_err(|_| {
        err_string(ToolError::invalid("file is not valid UTF-8 — cannot edit"))
    })?;
    let count = original.matches(&old_string).count();
    if count == 0 {
        return Err(err_string(ToolError::NotFound {
            message: "old_string not found in file".into(),
        }));
    }
    let replace_all = replace_all.unwrap_or(false);
    if count > 1 && !replace_all {
        return Err(err_string(ToolError::invalid(format!(
            "old_string matches {count} times; pass replace_all=true or include more surrounding context to make it unique"
        ))));
    }
    let updated = if replace_all {
        original.replace(&old_string, &new_string)
    } else {
        original.replacen(&old_string, &new_string, 1)
    };
    let new_size = updated.len() as u64;
    if new_size as usize > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("edited content exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    tokio::fs::write(&resolved, updated.as_bytes())
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    Ok(EditResult {
        replacements: if replace_all { count as u32 } else { 1 },
        new_size,
    })
}

/* ── File exists ─────────────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct ExistsResult {
    pub exists: bool,
    pub kind: Option<String>,
    pub size: Option<u64>,
}

pub async fn file_exists(path: String) -> Result<ExistsResult, String> {
    let resolved = match resolve_path(&path, false) {
        Ok(p) => p,
        Err(e) => return Err(err_string(ToolError::invalid(e.to_string()))),
    };
    match tokio::fs::metadata(&resolved).await {
        Ok(m) => {
            let kind = if m.is_dir() {
                "dir"
            } else if m.file_type().is_symlink() {
                "symlink"
            } else {
                "file"
            };
            Ok(ExistsResult {
                exists: true,
                kind: Some(kind.into()),
                size: if m.is_file() { Some(m.len()) } else { None },
            })
        }
        Err(_) => Ok(ExistsResult { exists: false, kind: None, size: None }),
    }
}

/* ── Search files (line-grep w/ basic glob) ──────────────────────────────── */

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub files_scanned: u32,
    pub truncated_hits: bool,
    pub truncated_scan: bool,
}

fn name_matches_glob(name: &str, glob: &str) -> bool {
    // Very simple glob — supports trailing `*` and `*.ext`.
    if glob == "*" || glob.is_empty() {
        return true;
    }
    if let Some(suffix) = glob.strip_prefix("*") {
        return name.ends_with(suffix);
    }
    if let Some(prefix) = glob.strip_suffix("*") {
        return name.starts_with(prefix);
    }
    name == glob
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
];

fn walk_search(
    root: &Path,
    needle: &str,
    glob: &str,
    files_scanned: &mut u32,
    hits: &mut Vec<SearchHit>,
) -> bool /* truncated_scan */ {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if is_protected_for_read(&p) || !within_workspace(&p) {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if SKIP_DIRS.contains(&name) || name.starts_with(".") {
                        continue;
                    }
                }
                stack.push(p);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !name_matches_glob(name, glob) {
                continue;
            }
            *files_scanned += 1;
            if *files_scanned as usize > MAX_SEARCH_FILES_SCANNED {
                return true;
            }
            let Ok(bytes) = std::fs::read(&p) else { continue };
            if bytes.len() > 2 * 1024 * 1024 {
                continue; // skip files > 2 MiB
            }
            let Ok(text) = std::str::from_utf8(&bytes) else { continue };
            for (i, line) in text.lines().enumerate() {
                if line.contains(needle) {
                    let mut trimmed = line.to_string();
                    if trimmed.len() > MAX_GREP_LINE_BYTES {
                        trimmed.truncate(MAX_GREP_LINE_BYTES);
                        trimmed.push_str("…");
                    }
                    hits.push(SearchHit {
                        path: p.to_string_lossy().into_owned(),
                        line: (i + 1) as u32,
                        text: trimmed,
                    });
                    if hits.len() >= MAX_SEARCH_HITS {
                        return false;
                    }
                }
            }
        }
    }
    false
}

pub async fn search_files(
    path: String,
    pattern: String,
    glob: Option<String>,
) -> Result<SearchResult, String> {
    if pattern.is_empty() {
        return Err(err_string(ToolError::invalid("pattern must not be empty")));
    }
    if pattern.len() > 512 {
        return Err(err_string(ToolError::invalid("pattern too long")));
    }
    let resolved = validate_for_read(&path).map_err(err_string)?;
    let glob = glob.unwrap_or_else(|| "*".into());

    let resolved2 = resolved.clone();
    let pattern2 = pattern.clone();
    let glob2 = glob.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut files_scanned: u32 = 0;
        let truncated_scan =
            walk_search(&resolved2, &pattern2, &glob2, &mut files_scanned, &mut hits);
        let truncated_hits = hits.len() >= MAX_SEARCH_HITS;
        SearchResult {
            hits,
            files_scanned,
            truncated_hits,
            truncated_scan,
        }
    })
    .await
    .map_err(|e| err_string(ToolError::io(e.to_string())))?;
    Ok(result)
}
