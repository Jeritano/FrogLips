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
            // Sec re-review H-1: the uid check below is necessary but not
            // sufficient — files extracted from an attacker-shipped repo
            // ARE owned by the extracting user, so uid match alone never
            // distinguishes "I wrote this" from "I cloned it". The real
            // defense is a sticky per-project trust marker the user
            // explicitly opts into. Until that lands we ALSO require the
            // policy directory to carry a `trust_marker` file the user
            // (not the repo) authored. Absence = the policy is parsed
            // for diagnostics only, NOT honored as auto-approval.
            if !is_owned_by_current_user(&candidate) {
                // Maturity review P1 #34: routed through diagnostics so
                // policy-load failures surface in the rolling log + UI
                // diagnostics panel, not just stderr (which on macOS is
                // captured only by Console.app — invisible to non-dev
                // users investigating "why isn't my policy in effect?").
                crate::diagnostics::warn_with(
                    "policy",
                    &format!(
                        "refusing {} — file is not owned by the current user",
                        candidate.display()
                    ),
                    serde_json::json!({ "path": candidate.to_string_lossy() }),
                );
                return None;
            }
            if !user_trusts_policy_dir(dir) {
                crate::diagnostics::info(
                    "policy",
                    &format!(
                        "{} found but project is not user-trusted — policy will be ignored \
                         until the user creates `{}/.froglips/.trusted`",
                        candidate.display(),
                        dir.display()
                    ),
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
                        crate::diagnostics::warn_with(
                            "policy",
                            &format!("failed to parse {}: {} — ignoring", candidate.display(), e),
                            serde_json::json!({
                                "path": candidate.to_string_lossy(),
                                "error": e.to_string(),
                            }),
                        );
                        return None;
                    }
                },
                Err(e) => {
                    crate::diagnostics::warn_with(
                        "policy",
                        &format!("failed to read {}: {} — ignoring", candidate.display(), e),
                        serde_json::json!({
                            "path": candidate.to_string_lossy(),
                            "error": e.to_string(),
                        }),
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
/// equals the running process's effective uid. Sec re-review M-NEW-4:
/// previously compared against the owner of `$HOME` as a "stable proxy"
/// — but the kernel sets a file's owner to whoever extracts/creates it,
/// so an attacker-shipped policy file inside a cloned repo is owned by
/// the EXTRACTING user (same uid as $HOME) and the check never fired.
/// Now uses `libc::geteuid` directly so the comparison reflects the
/// running process's real uid.
/// User-opt-in trust marker. A project's `.froglips/policy.json` is honored
/// only when `.froglips/.trusted` exists in the same directory AND is owned by
/// the current user.
///
/// L30: this is a WEAK marker — presence + ownership ONLY. There is no
/// signature / keychain binding / content check (an earlier comment overclaimed
/// one). The real defense against a repo shipping an auto-approve policy is
/// `isRepoLocalPolicy` in runner.ts, which suppresses repo-local Auto verdicts
/// regardless of this marker. Do not treat `.trusted` as cryptographically
/// strong, and do not "simplify away" the runner.ts suppression on its account.
fn user_trusts_policy_dir(project_root: &Path) -> bool {
    let marker = project_root.join(POLICY_DIR).join(".trusted");
    if !marker.is_file() {
        return false;
    }
    // Marker must be owned by the current user. Same uid check as the
    // policy file; together they make replay across machines harder.
    is_owned_by_current_user(&marker)
}

fn is_owned_by_current_user(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(path) {
            Ok(md) => {
                // SAFETY: `geteuid` is async-signal-safe and takes no args.
                let euid = unsafe { libc::geteuid() };
                md.uid() == euid
            }
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        // SECURITY: Windows ownership check is not implemented yet — returning
        // `true` (the prior behavior) would auto-approve attacker-cloned
        // policy files. Refuse to honor policy.json on Windows until a
        // platform-correct implementation (GetFileInformationByHandle +
        // GetCurrentProcessUser via OpenProcessToken + GetTokenInformation)
        // lands. The cost of false-negative (refuse a legit user-owned
        // policy) is much lower than the cost of false-positive (silently
        // honor a malicious one).
        let _ = path;
        false
    }
}

/// Decide whether a shell command should auto-approve, prompt, or be
/// denied based on `policy.allowed_shell_prefixes`.
///
/// Semantics:
///   - If `allowed_shell_prefixes` is `None`, return `NeedsConfirm`
///     (no policy opinion → keep existing behaviour).
///   - The command is normalized before matching: leading `NAME=value`
///     env-assignment tokens are skipped, the program token is unquoted,
///     and only its basename is considered (so `/usr/bin/cargo build` and
///     `"cargo" build` both normalize to `cargo`). The normalized program
///     name is compared for exact equality against each allowed entry's own
///     unquoted basename. On match, return `Auto`.
///   - Otherwise return `NeedsConfirm`. Policies never auto-deny shell
///     commands — destructive risk classification still applies upstream.
///
/// Review (low/bug): the field is named `allowed_shell_prefixes`, which led
/// users to expect normalized-program matching; the prior exact-first-token
/// check never auto-approved `CARGO_TERM_COLOR=1 cargo build`,
/// `/usr/bin/cargo build`, or `"cargo" build`. This stays conservative — it
/// only ever widens auto-approve for the same program, never auto-denies, so
/// a miss still falls through to a confirmation prompt (fail-safe).
pub fn evaluate_shell(cmd: &str, policy: &ProjectPolicy) -> ShellDecision {
    let prefixes = match &policy.allowed_shell_prefixes {
        Some(p) => p,
        None => return Decision::NeedsConfirm,
    };
    let program = match normalized_program(cmd) {
        Some(p) => p,
        None => return Decision::NeedsConfirm,
    };
    if prefixes
        .iter()
        .any(|p| normalized_program(p) == Some(program))
    {
        Decision::Auto
    } else {
        Decision::NeedsConfirm
    }
}

/// Extract the program name a shell command actually invokes, normalized for
/// comparison: skip leading `NAME=value` env-assignment tokens, strip a
/// surrounding pair of single/double quotes, and reduce a path-prefixed
/// invocation (`/usr/bin/cargo`) to its basename. Returns `None` when no
/// program token can be identified (empty / env-assignments only).
fn normalized_program(cmd: &str) -> Option<&str> {
    let token = cmd.split_whitespace().find(|t| !is_env_assignment(t))?;
    let token = unquote(token);
    if token.is_empty() {
        return None;
    }
    // Basename: a path-prefixed program (`/usr/bin/cargo`) matches the bare
    // `cargo` entry. Backslashes aren't path separators on the unix shells we
    // target, so only `/` is split on.
    Some(token.rsplit('/').next().unwrap_or(token))
}

/// A leading `NAME=value` token (e.g. `CARGO_TERM_COLOR=always`) is an env
/// assignment the shell applies before the program, not the program itself.
/// Conservative: the name must be a non-empty run of identifier characters
/// before the first `=`, so a path like `a=b/c` or a flag is never mistaken
/// for an assignment.
fn is_env_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((name, _)) => {
            !name.is_empty() && name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Strip a single matching pair of surrounding `'` or `"` quotes. Only the
/// outer pair is removed; embedded quotes are left untouched.
fn unquote(token: &str) -> &str {
    for q in ['"', '\''] {
        if token.len() >= 2 && token.starts_with(q) && token.ends_with(q) {
            return &token[1..token.len() - 1];
        }
    }
    token
}

/// Decide whether a write to `path` should auto-approve, prompt, or be
/// denied.
///
/// `denied_write_paths` is checked first (deny wins). Then if
/// `allowed_write_paths` is set and the path matches one of its entries,
/// return `Auto`. Otherwise return `NeedsConfirm`.
/// Collapse `.` / `..` segments purely lexically (no filesystem access) so a
/// traversal in a renderer-supplied path can't fool the allow/deny patterns
/// (review L1). Filesystem canonicalization still happens later in fs.rs.
fn lexically_normalize(p: &Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn evaluate_write(path: &Path, policy: &ProjectPolicy) -> WriteDecision {
    // L1: evaluate the LEXICALLY-NORMALIZED path, not the raw IPC string. A `..`
    // segment could otherwise satisfy an allow pattern (granting Auto) or dodge
    // a deny pattern. fs.rs re-canonicalizes before the actual write (defense in
    // depth), but the auto-approve VERDICT must never be granted on a traversal.
    let normalized = lexically_normalize(path);
    let path_str = normalized.to_string_lossy();
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
    // Sec audit round 3: case-fold both sides. macOS APFS is case-insensitive,
    // so a user policy rule like `secrets/` / `.env` / `*.key` MUST also match
    // `Secrets/` / `.ENV` / `evil.KEY` — otherwise a prompt-injected agent
    // bypasses the user's own project deny rules just by changing case. Mirrors
    // the central denylist's `path_starts_with_ci`. (TS twin: runner.ts
    // matchesPolicyPattern — keep both in sync.)
    let path_lc = path.to_ascii_lowercase();
    let pattern_lc = pattern.to_ascii_lowercase();
    let path = path_lc.as_str();
    let pattern = pattern_lc.as_str();
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
        // Sec re-review H-1: load_for_cwd now requires an explicit
        // .trusted marker before honoring a project policy.
        std::fs::write(policy_dir.join(".trusted"), b"").unwrap();

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
        std::fs::write(policy_dir.join(".trusted"), b"").unwrap();
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

        // Review (low/bug): common invocation shapes now normalize to the
        // program name before matching.
        // Leading env-assignment token(s) are skipped.
        assert_eq!(
            evaluate_shell("CARGO_TERM_COLOR=always cargo build", &p),
            Decision::Auto
        );
        assert_eq!(evaluate_shell("FOO=1 BAR=2 git status", &p), Decision::Auto);
        // Path-prefixed program matches the bare entry via basename.
        assert_eq!(evaluate_shell("/usr/bin/cargo build", &p), Decision::Auto);
        // Surrounding quotes on the program token are stripped.
        assert_eq!(evaluate_shell("\"cargo\" build", &p), Decision::Auto);
        assert_eq!(evaluate_shell("'git' status", &p), Decision::Auto);
        // Still conservative: a different program sharing a prefix is NOT
        // auto-approved (no substring widening).
        assert_eq!(
            evaluate_shell("gitleaks detect", &p),
            Decision::NeedsConfirm
        );
        // Env-assignments only (no program) → NeedsConfirm, not a panic.
        assert_eq!(evaluate_shell("FOO=1", &p), Decision::NeedsConfirm);

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
    fn glob_matcher_is_case_insensitive() {
        // Sec audit round 3: APFS is case-insensitive, so a deny rule must catch
        // case-folded variants — else an injected agent bypasses the user's own
        // project deny rules just by changing case.
        assert!(matches_pattern("evil.KEY", "*.key"));
        assert!(matches_pattern("Foo.Key", "*.key"));
        assert!(matches_pattern("Secrets/db.json", "secrets/"));
        assert!(matches_pattern("nested/SECRETS/k", "secrets/"));
        assert!(matches_pattern(".ENV", ".env"));
        assert!(matches_pattern("path/to/.Env", ".env"));
        assert!(matches_pattern("SRC/main.rs", "src*"));
        // Component-wise still holds: a sibling sharing a prefix is not matched.
        assert!(!matches_pattern("publicsecrets/x", "secrets/"));
    }

    /// Cross-language parity (security-manifest dedup, Step 5). policy.rs
    /// `matches_pattern` and runner.ts `matchesPolicyPattern` are intentionally
    /// TWIN CODE — not merged — so this checked-in fixture is the contract that
    /// keeps them in lockstep. The TS test
    /// (`security-manifest-snapshot.test.ts`) loads the SAME JSON and asserts
    /// the same verdicts; any drift fails on one side.
    #[test]
    fn glob_matcher_matches_cross_language_fixture() {
        #[derive(serde::Deserialize)]
        struct Case {
            path: String,
            pattern: String,
            expect: bool,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        let raw = include_str!("../policy-matcher-fixture.json");
        let fixture: Fixture =
            serde_json::from_str(raw).expect("policy-matcher fixture must parse");
        for c in fixture.cases {
            assert_eq!(
                matches_pattern(&c.path, &c.pattern),
                c.expect,
                "matches_pattern({:?}, {:?}) drifted from the shared fixture",
                c.path,
                c.pattern
            );
        }
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

    #[test]
    fn evaluate_write_normalizes_traversal_before_matching() {
        // L1: a `..` segment must not let a path auto-approve via an allow rule
        // nor dodge a deny rule. Paths are lexically normalized first.
        let p = ProjectPolicy {
            allowed_write_paths: Some(vec!["src/".into()]),
            denied_write_paths: Some(vec!["secrets/".into()]),
            ..ProjectPolicy::default()
        };
        // `src/../secrets/x` normalizes to `secrets/x` → DENIED, not allowed.
        assert_eq!(
            evaluate_write(Path::new("src/../secrets/x"), &p),
            Decision::Denied
        );
        // `src/./main.rs` normalizes to `src/main.rs` → still Auto.
        assert_eq!(
            evaluate_write(Path::new("src/./main.rs"), &p),
            Decision::Auto
        );
        // A traversal that escapes the allow root is no longer auto-approved.
        assert_eq!(
            evaluate_write(Path::new("src/../README.md"), &p),
            Decision::NeedsConfirm
        );
    }

    #[test]
    fn evaluate_write_denies_case_folded_paths() {
        // Sec audit: macOS APFS is case-insensitive, so a lowercase deny rule
        // MUST still block a case-varied write target that hits the same file —
        // otherwise a prompt-injected agent bypasses the user's deny rule by
        // changing case. Patterns are lowercase; targets vary case.
        let p = ProjectPolicy {
            allowed_write_paths: Some(vec!["src/".into()]),
            denied_write_paths: Some(vec![".env".into(), "secrets/".into(), "*.key".into()]),
            ..ProjectPolicy::default()
        };
        assert_eq!(
            evaluate_write(Path::new("Secrets/db.json"), &p),
            Decision::Denied
        );
        assert_eq!(evaluate_write(Path::new(".ENV"), &p), Decision::Denied);
        assert_eq!(
            evaluate_write(Path::new("config/prod.KEY"), &p),
            Decision::Denied
        );
        // A true sibling that merely shares a prefix is NOT denied.
        assert_eq!(
            evaluate_write(Path::new("public/index.html"), &p),
            Decision::NeedsConfirm
        );
    }

    /* helpers */
    fn tempdir() -> PathBuf {
        // CI-flake fix: pid+nanos alone collides when two tests call this in the
        // same nanosecond under the parallel runner — then one test's
        // `remove_dir_all` nukes another's dir mid-run (the intermittent
        // `round_trip_parse_full_schema` failure). A process-global atomic seq
        // guarantees a unique path regardless of clock resolution. (No
        // set_current_dir here — every test passes the dir explicitly to
        // load_for_cwd, so there is no CWD race to serialize.)
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "froglips-policy-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
