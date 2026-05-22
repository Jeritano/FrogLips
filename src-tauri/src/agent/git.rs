use serde::Serialize;
use std::path::PathBuf;

use super::fs::{
    err_string, validate_for_read, validate_for_write, workspace_root_clone, ToolError,
    MAX_SHELL_OUTPUT,
};

#[derive(Serialize)]
pub struct GitResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub cwd: String,
}

async fn git_invoke(cwd: PathBuf, args: &[&str]) -> Result<GitResult, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(&cwd).args(args).kill_on_drop(true);
    let timeout = std::time::Duration::from_secs(10);
    // capped_output bounds stdout/stderr buffering — git output can be huge.
    let (out, err, code) = match tokio::time::timeout(
        timeout,
        super::shell::capped_output(cmd, MAX_SHELL_OUTPUT),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(err_string(ToolError::io(e.to_string()))),
        Err(_) => {
            return Err(err_string(ToolError::Timeout {
                message: "git timed out after 10s".into(),
            }))
        }
    };
    Ok(GitResult {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        exit_code: code,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

pub async fn git_status(path: Option<String>) -> Result<GitResult, String> {
    let cwd = match path {
        Some(p) => validate_for_read(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    git_invoke(cwd, &["status", "--short", "--branch"]).await
}

/// Repo content (commit messages, diffs) can be attacker-poisoned — scan the
/// stdout for prompt-injection patterns and wrap with a DATA-only marker.
fn wrap_stdout(mut r: GitResult) -> GitResult {
    let (wrapped, _n) = crate::agent::injection_scan::scan_and_wrap(&r.stdout);
    r.stdout = wrapped;
    r
}

pub async fn git_diff(path: Option<String>, staged: Option<bool>) -> Result<GitResult, String> {
    let cwd = match path {
        Some(p) => validate_for_read(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) {
        args.push("--staged");
    }
    git_invoke(cwd, &args).await.map(wrap_stdout)
}

pub async fn git_log(path: Option<String>, limit: Option<u32>) -> Result<GitResult, String> {
    let cwd = match path {
        Some(p) => validate_for_read(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    let n = limit.unwrap_or(20).min(200).to_string();
    git_invoke(cwd, &["log", "--oneline", "--decorate", "-n", &n])
        .await
        .map(wrap_stdout)
}

pub async fn git_show(reference: String, path: Option<String>) -> Result<GitResult, String> {
    static REF_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"^[A-Za-z0-9._/-]+$").unwrap());
    if reference.is_empty() || reference.len() > 128 || !REF_RE.is_match(&reference) {
        return Err(err_string(ToolError::invalid(
            "ref contains illegal characters",
        )));
    }
    let cwd = match path {
        Some(p) => validate_for_read(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    git_invoke(cwd, &["show", "--no-color", &reference])
        .await
        .map(wrap_stdout)
}

pub async fn git_branches(path: Option<String>) -> Result<GitResult, String> {
    let cwd = match path {
        Some(p) => validate_for_read(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    git_invoke(cwd, &["branch", "-a", "--no-color"]).await
}

pub async fn git_commit(message: String, path: Option<String>) -> Result<GitResult, String> {
    if message.trim().is_empty() {
        return Err(err_string(ToolError::invalid(
            "commit message must not be empty",
        )));
    }
    if message.len() > 8192 {
        return Err(err_string(ToolError::invalid("commit message too long")));
    }
    let cwd = match path {
        Some(p) => validate_for_write(&p).map_err(err_string)?,
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        })?,
    };
    git_invoke(cwd, &["commit", "-m", &message]).await
}
