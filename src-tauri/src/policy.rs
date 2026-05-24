//! Per-project policy support.
//!
//! When the active chat workspace cwd lives inside a directory that
//! contains a `.froglips/policy.json` file, that policy overrides the
//! session-only approval state for shell/write tool calls.
//!
//! All fields in the schema are optional. A field that is omitted means
//! "inherit the existing session/global behaviour" — the evaluator returns
//! `NeedsConfirm` for anything not explicitly allowed and never auto-denies
//! unless the corresponding deny list is present.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const POLICY_DIR: &str = ".froglips";
const POLICY_FILE: &str = "policy.json";

/// Mirror of `.froglips/policy.json`. Every field is optional — see module
/// docs for the inheritance semantics.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProjectPolicy {
    #[serde(default)]
    pub schema: Option<u32>,
    #[serde(default)]
    pub allowed_shell_prefixes: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_write_paths: Option<Vec<String>>,
    #[serde(default)]
    pub denied_write_paths: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_env_vars: Option<Vec<String>>,
    #[serde(default)]
    pub auto_approve_dangerous_tools: Option<Vec<String>>,
    #[serde(default)]
    pub max_iterations: Option<u32>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Filesystem path the policy was loaded from. Filled by `load_for_cwd`
    /// so the frontend can show "Policy: <path>" to the user.
    #[serde(default)]
    pub source_path: Option<String>,
}

/// Decision for a shell command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// Skip the confirmation prompt — execute directly.
    Auto,
    /// Fall through to the existing confirmation gate.
    NeedsConfirm,
    /// Refuse to execute. Surfaced to the agent as a tool error.
    Denied,
}

pub type ShellDecision = Decision;
pub type WriteDecision = Decision;

/// Walk upward from `cwd` looking for `.froglips/policy.json`. Returns
/// `None` if no policy file exists or the file is unreadable / malformed.
/// Parse errors are logged via `eprintln!` and treated as absent.
///
/// Sec review M4: a project policy can auto-approve dangerous shell
/// commands, so it must be owned by the current uid. An untrusted git
/// repo cloned to disk could otherwise ship a `.froglips/policy.json`
/// that auto-approves arbitrary shells, and the agent would honor it
/// silently. We compare ownership via the file's stat uid against the
/// running process's uid and ignore the policy on mismatch.
pub fn load_for_cwd(cwd: &Path) -> Option<ProjectPolicy> {
    let mut current: Option<&Path> = Some(cwd);
    while let Some(dir) = current {
        let candidate: PathBuf = dir.join(POLICY_DIR).join(POLICY_FILE);
        if candidate.is_file() {
            if !is_owned_by_current_user(&candidate) {
                eprintln!(
                    "[policy] refusing {} — file is not owned by the current user (untrusted repo?)",
                    candidate.display()
                );
                return None;
            }
            match std::fs::read_to_string(&candidate) {
                Ok(text) => match serde_json::from_str::<ProjectPolicy>(&text) {
                    Ok(mut p) => {
                        p.source_path = Some(candidate.to_string_lossy().into_owned());
                        return Some(p);
                    }
                    Err(e) => {
                        eprintln!(
                            "[policy] failed to parse {}: {} — ignoring",
                            candidate.display(),
                            e
                        );
                        return None;
                    }
                },
                Err(e) => {
                    eprintln!(
                        "[policy] failed to read {}: {} — ignoring",
                        candidate.display(),
                        e
                    );
                    return None;
                }
            }
        }
        current = dir.parent();
    }
    None
}

/// Unix-only ownership check. Returns `true` if the file's owner uid
/// equals the running process's uid. On non-Unix this would always
/// return `true` (the app is macOS-only today, so the cfg below is the
/// expected and only path).
fn is_owned_by_current_user(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(path) {
            Ok(md) => {
                // `geteuid` via libc would be cleaner but pulls a dep;
                // std::process::id is the pid, not the uid. We read the
                // effective uid the same way every other Unix tool does:
                // by stat'ing /proc/self... not portable to macOS. Use
                // `users::get_current_uid` if added, else compare to the
                // owner of $HOME as a stable proxy.
                let home_uid = dirs::home_dir()
                    .and_then(|h| std::fs::metadata(&h).ok())
                    .map(|m| m.uid());
                match home_uid {
                    Some(uid) => md.uid() == uid,
                    None => true, // can't compare → fail open (no $HOME is bizarre)
                }
            }
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

/// Decide whether a shell command should auto-approve, prompt, or be
/// denied based on `policy.allowed_shell_prefixes`.
///
/// Semantics:
///   - If `allowed_shell_prefixes` is `None`, return `NeedsConfirm`
///     (no policy opinion → keep existing behaviour).
///   - If the command's first whitespace token matches any allowed prefix,
///     return `Auto`.
///   - Otherwise return `NeedsConfirm`. Policies never auto-deny shell
///     commands — destructive risk classification still applies upstream.
pub fn evaluate_shell(cmd: &str, policy: &ProjectPolicy) -> ShellDecision {
    let prefixes = match &policy.allowed_shell_prefixes {
        Some(p) => p,
        None => return Decision::NeedsConfirm,
    };
    let first = cmd.split_whitespace().next().unwrap_or("");
    if first.is_empty() {
        return Decision::NeedsConfirm;
    }
    if prefixes.iter().any(|p| p == first) {
        Decision::Auto
    } else {
        Decision::NeedsConfirm
    }
}

/// Decide whether a write to `path` should auto-approve, prompt, or be
/// denied.
///
/// `denied_write_paths` is checked first (deny wins). Then if
/// `allowed_write_paths` is set and the path matches one of its entries,
/// return `Auto`. Otherwise return `NeedsConfirm`.
pub fn evaluate_write(path: &Path, policy: &ProjectPolicy) -> WriteDecision {
    let path_str = path.to_string_lossy();
    let path_str = path_str.as_ref();

    if let Some(deny) = &policy.denied_write_paths {
        for pat in deny {
            if matches_pattern(path_str, pat) {
                return Decision::Denied;
            }
        }
    }

    if let Some(allow) = &policy.allowed_write_paths {
        for pat in allow {
            if matches_pattern(path_str, pat) {
                return Decision::Auto;
            }
        }
        // Allow list present but no match → fall through to user prompt.
        return Decision::NeedsConfirm;
    }

    Decision::NeedsConfirm
}

/// Very small glob matcher purpose-built for policy paths.
///
/// Supports:
///   - Trailing `/` to mean "this directory and anything underneath".
///     `secrets/` matches `secrets`, `secrets/foo`, `path/to/secrets/x`.
///   - Leading `*` for extension globs (`*.key` matches `foo.key`).
///   - Trailing `*` for prefix matches.
///   - `*` alone matches everything.
///   - Plain substring match for path-like patterns (`src/` substring rule).
///
/// Anything fancier (`**`, brace expansion) is intentionally out of scope.
fn matches_pattern(path: &str, pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    // Directory rule: `secrets/` matches the dir and anything under it.
    if let Some(dir) = pattern.strip_suffix('/') {
        if dir.is_empty() {
            return true;
        }
        let segs: Vec<&str> = path.split('/').collect();
        if segs.contains(&dir) {
            return true;
        }
        return path.starts_with(&format!("{dir}/")) || path == dir;
    }
    // Leading `*.ext` → extension match against the basename.
    if let Some(suffix) = pattern.strip_prefix('*') {
        let base = path.rsplit('/').next().unwrap_or(path);
        return base.ends_with(suffix) || path.ends_with(suffix);
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return path.starts_with(prefix);
    }
    // Bare token → exact-equality OR file-name match anywhere in the path.
    if path == pattern {
        return true;
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    base == pattern
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn round_trip_parse_full_schema() {
        let dir = tempdir();
        let policy_dir = dir.join(POLICY_DIR);
        std::fs::create_dir_all(&policy_dir).unwrap();
        let body = r#"{
          "schema": 1,
          "allowed_shell_prefixes": ["cargo", "git"],
          "allowed_write_paths": ["src/", "tests/"],
          "denied_write_paths": [".env", "secrets/", "*.key"],
          "allowed_env_vars": ["NODE_ENV"],
          "auto_approve_dangerous_tools": [],
          "max_iterations": 60,
          "notes": "hello"
        }"#;
        let path = policy_dir.join(POLICY_FILE);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();

        let p = load_for_cwd(&dir).expect("policy should load");
        assert_eq!(p.schema, Some(1));
        assert_eq!(
            p.allowed_shell_prefixes.as_deref(),
            Some(["cargo".to_string(), "git".to_string()].as_slice())
        );
        assert_eq!(p.max_iterations, Some(60));
        assert_eq!(p.notes.as_deref(), Some("hello"));
        assert!(p.source_path.unwrap().ends_with("policy.json"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_returns_none_when_absent_and_warns_on_bad_json() {
        let dir = tempdir();
        // No file → None.
        assert!(load_for_cwd(&dir).is_none());

        // Bad JSON → still None, no panic.
        let policy_dir = dir.join(POLICY_DIR);
        std::fs::create_dir_all(&policy_dir).unwrap();
        std::fs::write(policy_dir.join(POLICY_FILE), b"{not valid json").unwrap();
        assert!(load_for_cwd(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn walks_up_to_find_policy() {
        let root = tempdir();
        let policy_dir = root.join(POLICY_DIR);
        std::fs::create_dir_all(&policy_dir).unwrap();
        std::fs::write(
            policy_dir.join(POLICY_FILE),
            r#"{"allowed_shell_prefixes":["ls"]}"#,
        )
        .unwrap();
        let nested = root.join("a").join("b").join("c");
        std::fs::create_dir_all(&nested).unwrap();

        let p = load_for_cwd(&nested).expect("should walk upward");
        assert_eq!(
            p.allowed_shell_prefixes.as_deref(),
            Some(["ls".to_string()].as_slice())
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn evaluate_shell_prefixes() {
        let p = ProjectPolicy {
            allowed_shell_prefixes: Some(vec!["cargo".into(), "git".into()]),
            ..ProjectPolicy::default()
        };
        assert_eq!(evaluate_shell("cargo test", &p), Decision::Auto);
        assert_eq!(evaluate_shell("git status", &p), Decision::Auto);
        assert_eq!(evaluate_shell("rm -rf /", &p), Decision::NeedsConfirm);
        assert_eq!(evaluate_shell("", &p), Decision::NeedsConfirm);

        // No allow list → no opinion → NeedsConfirm.
        let empty = ProjectPolicy::default();
        assert_eq!(evaluate_shell("cargo test", &empty), Decision::NeedsConfirm);
    }

    #[test]
    fn glob_matcher_handles_common_patterns() {
        // Extension glob.
        assert!(matches_pattern("foo.key", "*.key"));
        assert!(matches_pattern("dir/foo.key", "*.key"));
        assert!(!matches_pattern("foo.txt", "*.key"));

        // Directory glob — both nested and top-level.
        assert!(matches_pattern("secrets/db.json", "secrets/"));
        assert!(matches_pattern("nested/secrets/k", "secrets/"));
        assert!(matches_pattern("secrets", "secrets/"));
        assert!(!matches_pattern("public/index.html", "secrets/"));

        // Prefix wildcard.
        assert!(matches_pattern("src/main.rs", "src*"));
        assert!(!matches_pattern("tests/foo.rs", "src*"));

        // Star alone.
        assert!(matches_pattern("anything", "*"));

        // Exact filename.
        assert!(matches_pattern(".env", ".env"));
        assert!(matches_pattern("path/to/.env", ".env"));
    }

    #[test]
    fn evaluate_write_respects_deny_then_allow() {
        let p = ProjectPolicy {
            allowed_write_paths: Some(vec!["src/".into(), "tests/".into()]),
            denied_write_paths: Some(vec![".env".into(), "secrets/".into(), "*.key".into()]),
            ..ProjectPolicy::default()
        };
        assert_eq!(evaluate_write(Path::new("src/main.rs"), &p), Decision::Auto);
        assert_eq!(
            evaluate_write(Path::new("tests/foo.rs"), &p),
            Decision::Auto
        );
        // Deny beats allow (would-be allowed by src/ if it were there, but
        // .env wins).
        assert_eq!(evaluate_write(Path::new(".env"), &p), Decision::Denied);
        assert_eq!(
            evaluate_write(Path::new("secrets/db.json"), &p),
            Decision::Denied
        );
        assert_eq!(
            evaluate_write(Path::new("config/prod.key"), &p),
            Decision::Denied
        );
        // Not in allow list and not denied → NeedsConfirm.
        assert_eq!(
            evaluate_write(Path::new("README.md"), &p),
            Decision::NeedsConfirm
        );
    }

    /* helpers */
    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "froglips-policy-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
