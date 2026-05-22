use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub(super) const MAX_READ_BYTES: usize = 65_536;
pub(super) const MAX_SHELL_OUTPUT: usize = 32_768;
pub(super) const MAX_PATH_LEN: usize = 4096;
pub(super) const MAX_WRITE_BYTES: usize = 1_048_576;
pub(super) const MAX_LIST_ENTRIES: usize = 500;
pub(super) const MAX_SEARCH_HITS: usize = 200;
pub(super) const MAX_SEARCH_FILES_SCANNED: usize = 2000;
pub(super) const MAX_GREP_LINE_BYTES: usize = 1024;

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
    let display = normalized
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    *WORKSPACE_ROOT
        .write()
        .map_err(|_| "workspace lock poisoned")? = normalized;
    Ok(display)
}

pub fn get_workspace_root() -> Option<String> {
    WORKSPACE_ROOT
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.to_string_lossy().into_owned()))
}

pub(super) fn workspace_root_clone() -> Option<PathBuf> {
    WORKSPACE_ROOT.read().ok().and_then(|g| g.clone())
}

/* ── Path validation w/ canonicalization + sandbox ─────────────────────────── */

pub(super) use crate::util::expand_home;

/// Resolves a user-supplied path. For existing paths, canonicalizes (follows
/// symlinks). For not-yet-existing paths (write targets), canonicalizes the
/// parent and joins the final component, then explicitly rejects `..` segments.
pub(super) fn resolve_path(p: &str, must_exist: bool) -> Result<PathBuf> {
    let raw = expand_home(p)?;
    // Reject explicit `..` traversal in the source string outright — prevents
    // write-side path tricks even if the parent canonicalizes elsewhere.
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(anyhow!("path may not contain '..'"));
    }
    if must_exist {
        std::fs::canonicalize(&raw).map_err(|e| anyhow!("path not accessible: {e}"))
    } else if let Ok(c) = std::fs::canonicalize(&raw) {
        Ok(c)
    } else if let Some(parent) = raw.parent() {
        let cparent =
            std::fs::canonicalize(parent).map_err(|e| anyhow!("parent not accessible: {e}"))?;
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

pub(super) fn is_protected_for_read(p: &Path) -> bool {
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
            // Credential files blocked for write but previously readable.
            ".netrc",
            ".npmrc",
            ".docker/config.json",
            ".kube",
            ".config/gh",
            ".config/gcloud",
            // Browser profile dirs holding cookies / saved credentials.
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/Firefox",
            "Library/Application Support/com.apple.Safari",
            "Library/Safari",
            // Froglips' own settings file — may still hold migrated secrets.
            "Library/Application Support/Froglips/settings.json",
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

pub(super) fn within_workspace(p: &Path) -> bool {
    match workspace_root_clone() {
        None => true,
        Some(root) => p.starts_with(&root),
    }
}

/* ── Structured result types ──────────────────────────────────────────────── */

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ToolError {
    NotFound { message: String },
    PermissionDenied { message: String },
    Protected { message: String },
    OutsideWorkspace { message: String },
    InvalidArgument { message: String },
    TooLarge { message: String },
    Timeout { message: String },
    Cancelled { message: String },
    Io { message: String },
}

impl ToolError {
    pub(super) fn invalid<S: Into<String>>(m: S) -> Self {
        ToolError::InvalidArgument { message: m.into() }
    }
    pub(super) fn io<S: Into<String>>(m: S) -> Self {
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
            | ToolError::Cancelled { message }
            | ToolError::Io { message } => write!(f, "{}", message),
        }
    }
}

pub(super) fn err_string(e: ToolError) -> String {
    serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
}

pub(super) fn classify_io(e: &std::io::Error) -> ToolError {
    use std::io::ErrorKind::*;
    let m = e.to_string();
    match e.kind() {
        NotFound => ToolError::NotFound { message: m },
        PermissionDenied => ToolError::PermissionDenied { message: m },
        _ => ToolError::io(m),
    }
}

pub(super) fn validate_for_read(p: &str) -> Result<PathBuf, ToolError> {
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

pub(super) fn validate_for_write(p: &str) -> Result<PathBuf, ToolError> {
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
    // resolve_path canonicalizes only the parent for write targets, so an
    // existing symlink leaf would let a write escape via the link target.
    // Reject symlinked leaves and re-check the canonical target.
    if let Ok(md) = std::fs::symlink_metadata(&resolved) {
        if md.file_type().is_symlink() {
            return Err(ToolError::Protected {
                message: "refusing to write through a symlink".into(),
            });
        }
        if let Ok(canon) = std::fs::canonicalize(&resolved) {
            if is_protected_for_write(&canon) {
                return Err(ToolError::Protected {
                    message: "path is restricted for writes".into(),
                });
            }
            if !within_workspace(&canon) {
                return Err(ToolError::OutsideWorkspace {
                    message: "path is outside workspace root".into(),
                });
            }
        }
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

/* ── Read file (w/ pagination) ───────────────────────────────────────────── */

#[derive(Serialize)]
pub struct ReadResult {
    pub content: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub truncated: bool,
    pub binary: bool,
}

pub(super) fn looks_binary(bytes: &[u8]) -> bool {
    // Scan the first ~8 KB for bytes that text files never contain.
    // - NUL is the classic binary tell.
    // - C0 control codes outside tab (09), LF (0A), CR (0D) are also rare in
    //   text; their presence flags formats like ELF (starts 0x7F), classic
    //   Mach-O / PE binaries, compiled bytecode, etc.
    // - DEL (0x7F) is similarly non-text.
    let scan = &bytes[..bytes.len().min(8192)];
    scan.iter().any(|&b| {
        b == 0 || (b < 0x09) || b == 0x0B || b == 0x0C || (b > 0x0D && b < 0x20) || b == 0x7F
    })
}

pub async fn read_file(
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<ReadResult, String> {
    let resolved = validate_for_read(&path).map_err(err_string)?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    let total = bytes.len() as u64;
    if looks_binary(&bytes) {
        return Ok(ReadResult {
            content: format!("[binary file, {total} bytes — use a different tool for binary data]"),
            bytes_read: 0,
            total_bytes: total,
            truncated: true,
            binary: true,
        });
    }
    let start = offset.unwrap_or(0).min(total);
    // Clamp tiny limits to MIN_READ_BYTES to prevent agents from blowing
    // iteration budget on pathologically small chunked reads (e.g. limit=300).
    const MIN_READ_BYTES: u64 = 8_192;
    let requested = limit.unwrap_or(MAX_READ_BYTES as u64);
    let cap = requested.max(MIN_READ_BYTES).min(MAX_READ_BYTES as u64);
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
    // Files can be attacker-poisoned — scan for prompt-injection patterns and
    // wrap with a DATA-only marker before the agent ingests them.
    let (content, _n) = super::injection_scan::scan_and_wrap(&content);
    Ok(ReadResult {
        content,
        bytes_read: end - start,
        total_bytes: total,
        truncated,
        binary: false,
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
        return Err(err_string(ToolError::invalid(
            "old_string must not be empty",
        )));
    }
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("file exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    let original = String::from_utf8(bytes)
        .map_err(|_| err_string(ToolError::invalid("file is not valid UTF-8 — cannot edit")))?;
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
        Err(_) => Ok(ExistsResult {
            exists: false,
            kind: None,
            size: None,
        }),
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

enum Matcher {
    Literal(String),
    Regex(regex::Regex),
}

impl Matcher {
    fn matches(&self, line: &str) -> bool {
        match self {
            Matcher::Literal(s) => line.contains(s.as_str()),
            Matcher::Regex(re) => re.is_match(line),
        }
    }
}

fn walk_search(
    root: &Path,
    matcher: &Matcher,
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
            let Ok(bytes) = std::fs::read(&p) else {
                continue;
            };
            if bytes.len() > 2 * 1024 * 1024 {
                continue; // skip files > 2 MiB
            }
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };
            for (i, line) in text.lines().enumerate() {
                if matcher.matches(line) {
                    let mut trimmed = line.to_string();
                    if trimmed.len() > MAX_GREP_LINE_BYTES {
                        trimmed.truncate(MAX_GREP_LINE_BYTES);
                        trimmed.push('…');
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
    regex_mode: Option<bool>,
) -> Result<SearchResult, String> {
    if pattern.is_empty() {
        return Err(err_string(ToolError::invalid("pattern must not be empty")));
    }
    if pattern.len() > 512 {
        return Err(err_string(ToolError::invalid("pattern too long")));
    }
    let resolved = validate_for_read(&path).map_err(err_string)?;
    let glob = glob.unwrap_or_else(|| "*".into());
    let matcher = if regex_mode.unwrap_or(false) {
        match regex::Regex::new(&pattern) {
            Ok(re) => Matcher::Regex(re),
            Err(e) => return Err(err_string(ToolError::invalid(format!("regex: {e}")))),
        }
    } else {
        Matcher::Literal(pattern.clone())
    };

    let resolved2 = resolved.clone();
    let glob2 = glob.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut files_scanned: u32 = 0;
        let truncated_scan =
            walk_search(&resolved2, &matcher, &glob2, &mut files_scanned, &mut hits);
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

/* ── Multi-edit (atomic) ─────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct EditOp {
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

#[derive(Serialize)]
pub struct MultiEditResult {
    pub edits_applied: u32,
    pub total_replacements: u32,
    pub new_size: u64,
}

pub async fn multi_edit(path: String, edits: Vec<EditOp>) -> Result<MultiEditResult, String> {
    if edits.is_empty() {
        return Err(err_string(ToolError::invalid(
            "edits list must not be empty",
        )));
    }
    if edits.len() > 100 {
        return Err(err_string(ToolError::invalid("at most 100 edits per call")));
    }
    let resolved = validate_for_write(&path).map_err(err_string)?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("file exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    let mut content = String::from_utf8(bytes)
        .map_err(|_| err_string(ToolError::invalid("file is not valid UTF-8 — cannot edit")))?;

    let mut total_replacements: u32 = 0;
    for (i, e) in edits.iter().enumerate() {
        if e.old_string.is_empty() {
            return Err(err_string(ToolError::invalid(format!(
                "edit #{i}: old_string must not be empty"
            ))));
        }
        let count = content.matches(&e.old_string).count();
        if count == 0 {
            return Err(err_string(ToolError::NotFound {
                message: format!("edit #{i}: old_string not found"),
            }));
        }
        let all = e.replace_all.unwrap_or(false);
        if count > 1 && !all {
            return Err(err_string(ToolError::invalid(format!(
                "edit #{i}: matches {count} times; pass replace_all=true or include more context"
            ))));
        }
        if all {
            content = content.replace(&e.old_string, &e.new_string);
            total_replacements += count as u32;
        } else {
            content = content.replacen(&e.old_string, &e.new_string, 1);
            total_replacements += 1;
        }
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(err_string(ToolError::TooLarge {
            message: format!("edited content exceeds {MAX_WRITE_BYTES} bytes"),
        }));
    }
    let new_size = content.len() as u64;
    tokio::fs::write(&resolved, content.as_bytes())
        .await
        .map_err(|e| err_string(classify_io(&e)))?;
    Ok(MultiEditResult {
        edits_applied: edits.len() as u32,
        total_replacements,
        new_size,
    })
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_matches_glob_wildcards() {
        assert!(name_matches_glob("foo.ts", "*.ts"));
        assert!(name_matches_glob("README.md", "*.md"));
        assert!(name_matches_glob("config", "config"));
        assert!(name_matches_glob("config.json", "config*"));
        assert!(name_matches_glob("anything", "*"));
        assert!(name_matches_glob("anything", ""));
        assert!(!name_matches_glob("foo.ts", "*.rs"));
    }

    #[test]
    fn looks_binary_detection() {
        assert!(!looks_binary(b"hello world"));
        assert!(!looks_binary(b"#!/usr/bin/env bash\nset -e\n"));
        assert!(looks_binary(b"\x7fELF\x02"));
        assert!(looks_binary(b"some\0text"));
        assert!(!looks_binary(&[]));
    }

    #[test]
    fn expand_home_rejects_invalid() {
        assert!(expand_home("").is_err());
        assert!(expand_home("with\0null").is_err());
        let big = "a".repeat(MAX_PATH_LEN + 1);
        assert!(expand_home(&big).is_err());
    }

    #[test]
    fn resolve_path_rejects_parent_dir() {
        let result = resolve_path("/tmp/../etc/passwd", true);
        assert!(result.is_err(), "should reject .. in path");
    }
}
