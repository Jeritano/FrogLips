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
    // Harden against a malicious repo `.git/config`: pager / fsmonitor /
    // alias hooks can execute arbitrary commands on an otherwise read-only
    // operation like `git status`. Force-disable those mechanisms via `-c`
    // overrides, and `GIT_CONFIG_NOSYSTEM=1` blocks the system-wide config.
    cmd.arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.pager=cat")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .current_dir(&cwd)
        .args(args)
        .kill_on_drop(true);
    let timeout = std::time::Duration::from_secs(10);
    // capped_output bounds stdout/stderr buffering — git output can be huge.
    let (out, err, code) = match tokio::time::timeout(
        timeout,
        super::shell::capped_output(cmd, MAX_SHELL_OUTPUT, false),
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

/// Resolve the working directory for a git command: an explicit path is
/// validated, otherwise the workspace root is used. `for_write` selects the
/// read- vs write-side path validator.
fn resolve_git_cwd(path: Option<String>, for_write: bool) -> Result<PathBuf, String> {
    match path {
        Some(p) => {
            if for_write {
                validate_for_write(&p).map_err(err_string)
            } else {
                validate_for_read(&p).map_err(err_string)
            }
        }
        None => workspace_root_clone().ok_or_else(|| {
            err_string(ToolError::invalid(
                "no path given and no workspace root set",
            ))
        }),
    }
}

pub async fn git_status(path: Option<String>) -> Result<GitResult, String> {
    let cwd = resolve_git_cwd(path, false)?;
    // Sec audit round 6: wrap like git_diff/log/show — `status --short` includes
    // attacker-controllable FILENAMES (a hostile repo can contain a file named
    // to carry an injection payload) and the branch name.
    git_invoke(cwd, &["status", "--short", "--branch"])
        .await
        .map(wrap_stdout)
}

/// Repo content (commit messages, diffs) can be attacker-poisoned — scan the
/// stdout for prompt-injection patterns and wrap with a DATA-only marker.
fn wrap_stdout(mut r: GitResult) -> GitResult {
    let (wrapped, _n) = crate::agent::injection_scan::scan_and_wrap(&r.stdout);
    r.stdout = wrapped;
    // stderr is equally attacker-controllable (git echoes branch names, refs,
    // and pathspecs from a hostile repo on error) and is serialized to the
    // model alongside stdout — fence it too.
    let (werr, _n) = crate::agent::injection_scan::scan_and_wrap(&r.stderr);
    r.stderr = werr;
    r
}

pub async fn git_diff(path: Option<String>, staged: Option<bool>) -> Result<GitResult, String> {
    let cwd = resolve_git_cwd(path, false)?;
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) {
        args.push("--staged");
    }
    git_invoke(cwd, &args).await.map(wrap_stdout)
}

pub async fn git_log(path: Option<String>, limit: Option<u32>) -> Result<GitResult, String> {
    let cwd = resolve_git_cwd(path, false)?;
    let n = limit.unwrap_or(20).min(200).to_string();
    git_invoke(cwd, &["log", "--oneline", "--decorate", "-n", &n])
        .await
        .map(wrap_stdout)
}

pub async fn git_show(reference: String, path: Option<String>) -> Result<GitResult, String> {
    static REF_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"^[A-Za-z0-9._/-]+$").unwrap());
    // SEC-LOW (2026-05-30): reject a leading `-` so a `reference` like
    // `--stat` / `--output=…` can't be parsed by git as an OPTION instead of
    // a revision. A `--` end-of-options guard doesn't work for `git show`
    // (it would force the reference to be interpreted as a PATHSPEC, breaking
    // the command), so the validator rejects the dash directly.
    if reference.is_empty()
        || reference.len() > 128
        || reference.starts_with('-')
        || !REF_RE.is_match(&reference)
    {
        return Err(err_string(ToolError::invalid(
            "ref contains illegal characters",
        )));
    }
    let cwd = resolve_git_cwd(path, false)?;
    git_invoke(cwd, &["show", "--no-color", &reference])
        .await
        .map(wrap_stdout)
}

pub async fn git_branches(path: Option<String>) -> Result<GitResult, String> {
    let cwd = resolve_git_cwd(path, false)?;
    // Sec audit round 6: branch names are attacker-controllable in a hostile
    // cloned repo — wrap like the other git readers.
    git_invoke(cwd, &["branch", "-a", "--no-color"])
        .await
        .map(wrap_stdout)
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
    let cwd = resolve_git_cwd(path, true)?;
    git_invoke(cwd, &["commit", "-m", &message]).await
}
