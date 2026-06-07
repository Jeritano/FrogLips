//! Shared path-safety helpers for IPC commands that accept arbitrary
//! user-supplied destinations or sources. These mirror the same shape
//! constraints `agent::fs::validate_for_write` applies inside the agent
//! sandbox: absolute paths only, no `..` traversal, refuse symlinked
//! leaves, denylist credential-bearing system / per-user directories.
//!
//! Renderer-side bypasses (XSS, MCP server driving the agent loop, hostile
//! IPC) can otherwise hand `commands/data.rs` or `commands/misc.rs` paths
//! pointing into `~/.ssh`, `~/.aws`, the keychain, or other sensitive
//! locations the process has write access to. The same logic was already
//! inlined in `commands::misc::validate_diagnostics_dest`; factoring it
//! here lets `backup_database`, `export_data`, and `import_data` reuse it.

use std::path::PathBuf;

/// Validate a destination path the privileged backend is about to write to.
///
/// Returns the canonicalized resolved path. Rejects:
///   * empty / relative paths
///   * paths containing `..`
///   * symlinked leaves (so the resolved path can't escape via a swap-in)
///   * the system + per-user denylist (system dirs, keychain, ssh/aws/gpg,
///     gh config, mail/messages databases, TCC, sudo state, …)
///   * credential-style basenames inside the user's home (`.env*`,
///     `credentials`, `credentials.json`)
pub fn validate_write_dest(dest: &str) -> Result<PathBuf, String> {
    if dest.trim().is_empty() {
        return Err("destination path must not be empty".into());
    }
    let raw = PathBuf::from(dest);
    if !raw.is_absolute() {
        return Err("destination path must be absolute".into());
    }
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("destination path may not contain '..'".into());
    }
    let parent = raw
        .parent()
        .ok_or_else(|| "destination path has no parent".to_string())?;
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("destination parent not accessible: {e}"))?;
    let file_name = raw
        .file_name()
        .ok_or_else(|| "destination path has no file name".to_string())?;
    let resolved = canon_parent.join(file_name);

    // Reject writes through an existing symlink leaf — would let the resolved
    // path escape to a denylisted target after the parent check passes.
    if let Ok(md) = std::fs::symlink_metadata(&resolved) {
        if md.file_type().is_symlink() {
            return Err("refusing to write through a symlink".into());
        }
    }

    if is_denied(&resolved) {
        return Err("destination path is in a protected directory".into());
    }
    if is_credential_basename(&resolved) {
        return Err("destination filename is reserved".into());
    }
    Ok(resolved)
}

/// Validate a source path the privileged backend is about to read from.
///
/// Same shape constraints as `validate_write_dest`, plus an extra symlink
/// rejection on the leaf (so we can't be lured into reading from a
/// keychain / credential file through a symlinked source) and a check that
/// the file actually exists and is a regular file.
pub fn validate_read_src(src: &str) -> Result<PathBuf, String> {
    if src.trim().is_empty() {
        return Err("source path must not be empty".into());
    }
    let raw = PathBuf::from(src);
    if !raw.is_absolute() {
        return Err("source path must be absolute".into());
    }
    if raw
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("source path may not contain '..'".into());
    }
    // Reject a symlink at the leaf BEFORE canonicalizing — canonicalize() would
    // follow it into whatever the symlink points at, including denylisted dirs.
    if let Ok(md) = std::fs::symlink_metadata(&raw) {
        if md.file_type().is_symlink() {
            return Err("refusing to read through a symlink".into());
        }
    }
    // Now canonicalize the full path so we can check it against the denylist
    // with symlinked PARENT dirs resolved (the leaf has already been verified
    // not to be a symlink).
    let resolved =
        std::fs::canonicalize(&raw).map_err(|e| format!("source path not accessible: {e}"))?;
    let md =
        std::fs::symlink_metadata(&resolved).map_err(|e| format!("source not accessible: {e}"))?;
    if !md.file_type().is_file() {
        return Err("source must be a regular file".into());
    }
    if is_denied(&resolved) {
        return Err("source path is in a protected directory".into());
    }
    if is_credential_basename(&resolved) {
        return Err("source filename is reserved".into());
    }
    Ok(resolved)
}

/// Denylist mirrored from `agent::fs::is_protected_for_write`. Sec
/// re-review H-NEW-1: the H2 sweep expanded the agent/fs.rs list but
/// missed THIS one, so `backup_database` / `export_data` / `import_data`
/// could still target a LaunchAgent plist, shell rc, or Froglips' own DB
/// to plant persistence or rewrite settings. Kept in sync with
/// `agent::fs::protected_prefixes` — add new entries to BOTH places.
fn is_denied(resolved: &std::path::Path) -> bool {
    let mut deny: Vec<PathBuf> = [
        "/System",
        "/private/etc",
        "/etc",
        "/private/var/db/sudo",
        "/var/db/sudo",
        "/Library/Keychains",
        "/Library/Application Support/com.apple.TCC",
        "/Applications/Froglips.app",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    let Some(home) = dirs::home_dir() else {
        // Sec re-review M-2: when $HOME is unset, the entire per-user
        // denylist disappears and any path under /Users or /home becomes
        // writable. Fail closed — refuse the IPC entirely instead of
        // leaking attack surface. P1 #34: route through diagnostics so
        // a failed-closed call surfaces in the rolling log, not stderr.
        crate::diagnostics::warn_with(
            "path_safety",
            "home_dir() unavailable — denying by default",
            serde_json::json!({}),
        );
        return true;
    };
    {
        for sub in [
            ".ssh",
            ".aws",
            ".config/gh",
            ".config/gcloud",
            ".gnupg",
            "Library/Keychains",
            "Library/Cookies",
            "Library/Application Support/com.apple.TCC",
            "Library/Mail",
            "Library/Messages",
            // Sec re-review H-NEW-1: persistence + shell-init + IDE-state
            // surface — matches agent/fs.rs::protected_prefixes.
            "Library/LaunchAgents",
            "Library/LaunchDaemons",
            ".bash_profile",
            ".bashrc",
            ".profile",
            ".zshrc",
            ".zprofile",
            ".zshenv",
            "Library/Preferences/com.apple.Terminal.plist",
            ".netrc",
            ".npmrc",
            ".pypirc",
            ".gitconfig",
            ".docker/config.json",
            ".kube",
            ".local-llm-app",
            "Library/Application Support/Froglips",
            // Browser profile dirs — match agent/fs.rs::is_protected_for_read so
            // a write-dest can't clobber/tamper browser state (Secure
            // Preferences, extensions, cookies) that the agent fs layer blocks.
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/Firefox",
            "Library/Application Support/com.apple.Safari",
            "Library/Safari",
        ] {
            deny.push(home.join(sub));
        }
    }
    // Case-INSENSITIVE component-wise containment (sec audit round 2): macOS
    // APFS is case-insensitive but case-preserving, so a plain `starts_with`
    // let a renderer-supplied dest like `~/.SSH/authorized_keys` or `~/.ZSHRC`
    // slip past this write denylist and plant persistence / clobber creds.
    // Shares the exact helper the agent fs gate uses so the two can't drift.
    deny.iter()
        .any(|pre| crate::agent::fs::path_starts_with_ci(resolved, pre))
}

/// Reject credential-style basenames so a stray click can't overwrite or
/// read `~/.env`, `~/credentials.json`, etc. (would otherwise be inside
/// home and outside the explicit denylist above).
fn is_credential_basename(resolved: &std::path::Path) -> bool {
    if let Some(name) = resolved.file_name().and_then(|n| n.to_str()) {
        // Case-fold the basename (sec audit round 2) so `.ENV` / `Credentials`
        // can't slip past on a case-insensitive volume.
        let lower = name.to_ascii_lowercase();
        if lower.starts_with(".env") || lower == "credentials" || lower == "credentials.json" {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_relative_and_traversal() {
        assert!(validate_write_dest("").is_err());
        assert!(validate_write_dest("   ").is_err());
        assert!(validate_write_dest("relative/path").is_err());
        // `..` rejected outright.
        assert!(validate_write_dest("/tmp/../etc/foo").is_err());

        assert!(validate_read_src("").is_err());
        assert!(validate_read_src("relative/path").is_err());
        assert!(validate_read_src("/tmp/../etc/foo").is_err());
    }

    #[test]
    fn rejects_credential_basenames_in_home() {
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".env");
            assert!(is_credential_basename(&p));
            let p2 = home.join("credentials.json");
            assert!(is_credential_basename(&p2));
            let p3 = home.join("Downloads/notes.txt");
            assert!(!is_credential_basename(&p3));
        }
    }

    #[test]
    fn denies_system_and_per_user_dirs() {
        // Pure-path containment check — no fs access needed.
        assert!(is_denied(std::path::Path::new("/etc/passwd")));
        assert!(is_denied(std::path::Path::new("/System/Library/foo")));
        if let Some(home) = dirs::home_dir() {
            assert!(is_denied(&home.join(".ssh/id_rsa")));
            assert!(is_denied(&home.join(".aws/credentials")));
        }
        // Non-denylisted user path still passes.
        if let Some(home) = dirs::home_dir() {
            assert!(!is_denied(&home.join("Downloads/foo.json")));
        }
    }

    #[test]
    fn denies_case_folded_dirs_and_basenames() {
        // Sec audit round 2: case-insensitive volumes (APFS) must not let a
        // case-folded dest bypass this renderer-reachable write denylist.
        assert!(is_denied(std::path::Path::new("/ETC/passwd")));
        assert!(is_denied(std::path::Path::new(
            "/private/ETC/master.passwd"
        )));
        if let Some(home) = dirs::home_dir() {
            assert!(is_denied(&home.join(".SSH/authorized_keys")));
            assert!(is_denied(&home.join(".AWS/credentials")));
            assert!(is_denied(&home.join(".ZSHRC")));
            assert!(is_denied(&home.join("Library/LAUNCHAGENTS/evil.plist")));
            assert!(is_credential_basename(&home.join(".ENV")));
            assert!(is_credential_basename(&home.join("project/Credentials")));
            // Component-wise: a mere prefix sibling is still allowed.
            assert!(!is_denied(&home.join(".sshfoo/x")));
        }
    }
}
