use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const MAX_READ_BYTES: usize = 65_536;
const MAX_SHELL_OUTPUT: usize = 32_768;
const SHELL_TIMEOUT_SECS: u64 = 30;
const MAX_PATH_LEN: usize = 4096;
const MAX_WRITE_BYTES: usize = 1_048_576;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn validate_path(p: &str) -> Result<PathBuf> {
    if p.is_empty() || p.len() > MAX_PATH_LEN {
        return Err(anyhow!("path length invalid"));
    }
    if p.contains('\0') {
        return Err(anyhow!("path contains null byte"));
    }
    let expanded = if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| anyhow!("home dir unavailable"))?
            .join(rest)
    } else {
        PathBuf::from(p)
    };
    Ok(expanded)
}

fn is_protected(p: &Path) -> bool {
    let s = p.to_string_lossy();
    [
        "/System",
        "/Library/Keychains",
        "/private/etc",
        "/etc/passwd",
        "/etc/shadow",
        "/boot",
        "/proc/kcore",
    ]
    .iter()
    .any(|pr| s.starts_with(pr))
}

pub async fn read_file(path: String) -> Result<String, String> {
    let p = validate_path(&path).map_err(|e| e.to_string())?;
    if is_protected(&p) {
        return Err("path is restricted".into());
    }
    let bytes = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    let capped = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    let mut text = String::from_utf8_lossy(capped).into_owned();
    if bytes.len() > MAX_READ_BYTES {
        text.push_str(&format!("\n[... truncated — file is {} bytes total]", bytes.len()));
    }
    Ok(text)
}

pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let p = validate_path(&path).map_err(|e| e.to_string())?;
    if is_protected(&p) {
        return Err("path is restricted".into());
    }
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut rd = tokio::fs::read_dir(&p).await.map_err(|e| e.to_string())?;
    while let Some(e) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let ft = e.file_type().await.map_err(|e| e.to_string())?;
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
        if entries.len() >= 500 {
            break;
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

pub async fn run_shell(command: String) -> Result<ShellResult, String> {
    if command.is_empty() || command.len() > 4096 {
        return Err("command length invalid".into());
    }
    let timeout = std::time::Duration::from_secs(SHELL_TIMEOUT_SECS);
    let fut = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("timed out after {SHELL_TIMEOUT_SECS}s")),
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
    })
}

pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let p = validate_path(&path).map_err(|e| e.to_string())?;
    if is_protected(&p) {
        return Err("path is restricted".into());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("content exceeds {MAX_WRITE_BYTES} bytes"));
    }
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&p, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
