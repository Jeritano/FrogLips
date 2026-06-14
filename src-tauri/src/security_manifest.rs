//! Single source of truth for Froglips' path-safety + prompt-injection
//! security definitions, loaded ONCE from the checked-in
//! `security-manifest.json` (`include_str!`, so it is baked into the binary and
//! cannot drift from the build at runtime).
//!
//! Both the Rust path gates (`agent::fs`, `commands::path_safety`),
//! the Seatbelt cage (`agent::shell`), and the injection scanner
//! (`agent::injection_scan`) consume THIS module instead of carrying their own
//! literal denylist arrays — eliminating the hand-synced duplication that was
//! the largest "keep these N copies in lockstep" hazard in the codebase.
//!
//! The TS renderer side imports the same JSON directly (it has no FFI into this
//! module); cross-language parity is pinned by tests, not shared code.
//!
//! A wrong entry in the manifest is a vulnerability — every consumer is guarded
//! by a behavior-snapshot test (`agent::fs` battery, `agent::shell` deny-set,
//! the additive injection-token tests).

use serde::Deserialize;
use std::sync::OnceLock;

/// One protected-path entry. `path` is either a literal absolute path
/// (`ProtectedPaths::absolute`) or a path relative to `$HOME`
/// (`ProtectedPaths::home_relative`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedPath {
    pub path: String,
    /// Blocked from the agent read gate (read_file / list_dir / search_files).
    #[serde(default)]
    pub read: bool,
    /// Blocked from the agent write gate AND the renderer IPC write/read-src
    /// gate. Invariant: true wherever `read` is true.
    #[serde(default)]
    pub write: bool,
    /// Denied (file-read* file-write*) inside the run_shell/run_code Seatbelt
    /// cage. Consumed by `agent::shell`.
    #[serde(default, rename = "sandboxDeny")]
    pub sandbox_deny: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedPaths {
    pub absolute: Vec<ProtectedPath>,
    #[serde(rename = "homeRelative")]
    pub home_relative: Vec<ProtectedPath>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialBasenames {
    /// Case-folded `starts_with` matches (e.g. `.env` catches `.env.local`).
    pub prefixes: Vec<String>,
    /// Case-folded full-equality matches.
    pub exact: Vec<String>,
}

/// One injection role-framing token shared by the Rust scanner and the TS
/// fence. `token` is the literal sequence; `name` is the human-readable label
/// the scanner surfaces in its warning header. Consumed by
/// `agent::injection_scan`.
#[derive(Debug, Clone, Deserialize)]
pub struct InjectionRoleToken {
    pub token: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InjectionRoleTokens {
    pub tokens: Vec<InjectionRoleToken>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SecurityManifest {
    #[serde(rename = "protectedPaths")]
    pub protected_paths: ProtectedPaths,
    #[serde(rename = "credentialBasenames")]
    pub credential_basenames: CredentialBasenames,
    #[serde(rename = "injectionRoleTokens")]
    pub injection_role_tokens: InjectionRoleTokens,
}

/// Raw manifest text, baked into the binary at compile time.
const MANIFEST_JSON: &str = include_str!("../security-manifest.json");

static MANIFEST: OnceLock<SecurityManifest> = OnceLock::new();

/// The parsed manifest. Parse failure is a developer error (the JSON is a
/// checked-in literal validated by tests), so we panic-fast at first use rather
/// than silently degrading the security gates to "allow everything".
pub fn manifest() -> &'static SecurityManifest {
    MANIFEST.get_or_init(|| {
        serde_json::from_str(MANIFEST_JSON).expect("security-manifest.json must parse")
    })
}

impl SecurityManifest {
    /// Absolute literal paths blocked for read.
    pub fn absolute_read(&self) -> impl Iterator<Item = &str> {
        self.protected_paths
            .absolute
            .iter()
            .filter(|e| e.read)
            .map(|e| e.path.as_str())
    }

    /// Absolute literal paths blocked for write (the write gate's absolute set).
    pub fn absolute_write(&self) -> impl Iterator<Item = &str> {
        self.protected_paths
            .absolute
            .iter()
            .filter(|e| e.write)
            .map(|e| e.path.as_str())
    }

    /// `$HOME`-relative subpaths blocked for read.
    pub fn home_read(&self) -> impl Iterator<Item = &str> {
        self.protected_paths
            .home_relative
            .iter()
            .filter(|e| e.read)
            .map(|e| e.path.as_str())
    }

    /// `$HOME`-relative subpaths blocked for write.
    pub fn home_write(&self) -> impl Iterator<Item = &str> {
        self.protected_paths
            .home_relative
            .iter()
            .filter(|e| e.write)
            .map(|e| e.path.as_str())
    }

    /// `$HOME`-relative subpaths the Seatbelt cage denies for shell children.
    pub fn home_sandbox_deny(&self) -> impl Iterator<Item = &str> {
        self.protected_paths
            .home_relative
            .iter()
            .filter(|e| e.sandbox_deny)
            .map(|e| e.path.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses() {
        let m = manifest();
        assert!(!m.protected_paths.absolute.is_empty());
        assert!(!m.protected_paths.home_relative.is_empty());
        assert!(!m.injection_role_tokens.tokens.is_empty());
        assert!(!m.credential_basenames.prefixes.is_empty());
    }

    #[test]
    fn write_is_superset_of_read_for_every_entry() {
        // The path gates rely on this invariant (write gate calls read gate
        // first), so the manifest must never have read=true without write=true.
        let m = manifest();
        for e in m
            .protected_paths
            .absolute
            .iter()
            .chain(m.protected_paths.home_relative.iter())
        {
            if e.read {
                assert!(e.write, "read=true requires write=true for {}", e.path);
            }
        }
    }
}
