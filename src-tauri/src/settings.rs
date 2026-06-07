use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Settings {
    pub workspace_root: Option<String>,
    pub last_model: Option<String>,
    pub last_backend: Option<String>,
    pub memory_mode: Option<String>,
    pub active_preset_id: Option<String>,
    pub embedding_model: Option<String>,
    pub recall_threshold: Option<f32>,
    pub window: Option<WindowGeometry>,
    pub theme: Option<String>, // "dark" | "light"
    pub custom_backends: Option<Vec<CustomBackend>>,
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    /// First-run setup wizard completion flag. Defaults to `false` for a
    /// fresh install so the wizard auto-opens; the Settings panel exposes a
    /// "Re-run setup wizard" button that flips this back to `false` on demand.
    /// Wrapped in `Option` so users on older settings.json files (where the
    /// field is absent) deserialize as `None` → wizard treats as `false` →
    /// runs once, then writes `Some(true)` and never bothers them again.
    pub setup_complete: Option<bool>,
    /// User-authored "About You" profile. When `enabled`, its fields are
    /// formatted into a system-prompt block so every chat and workflow agent
    /// knows who the user is. Absent on legacy installs → `None` → not used.
    pub user_profile: Option<UserProfile>,
    /// HIGH-2 (2026-05-29): forward-compatibility capture. Any top-level key
    /// this build doesn't recognise (because it was written by a NEWER build)
    /// is parked here and re-serialized verbatim on save, so opening an old
    /// build can't silently destroy a newer build's settings. Skipped when
    /// empty so it never appears in a fresh file.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Explicit, user-edited identity facts (the "Custom Instructions" pattern).
/// Stored locally in settings.json; never auto-populated. All fields optional
/// so a partially-filled profile is valid.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct UserProfile {
    /// Master switch. When false the profile is ignored even if filled in.
    pub enabled: bool,
    pub name: Option<String>,
    pub occupation: Option<String>,
    pub location: Option<String>,
    /// Free-text "anything else the AI should know about you".
    pub about: Option<String>,
    /// Free-text "how the AI should respond" (tone, format, length).
    pub response_style: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct CustomBackend {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct McpServerConfig {
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Whether this server should be auto-started when the app launches.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Remote (streamable-HTTP) endpoint URL. When set, this is a remote MCP
    /// server: `command`/`args`/`env` are ignored and the bearer token (if any)
    /// is read from the Keychain under account `mcp:<name>`. When absent, it's
    /// a local stdio server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Local secret store: a mode-0600 JSON file (account → key) kept next to
/// settings.json. Replaces the macOS login Keychain so the OS never prompts
/// for access — the Keychain ACL reset on every ad-hoc re-sign, re-prompting
/// despite "Always Allow". Trade-off (accepted 2026-06-02): keys sit in a
/// local file readable by any process running as the user, vs the Keychain's
/// per-app ACL. Single-user local build; the file is mode 0600.
fn secrets_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("FROGLIPS_SETTINGS_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("secrets.json"));
        }
    }
    dirs::config_dir().map(|d| d.join("Froglips/secrets.json"))
}

/// Serializes secret-file read-modify-write so concurrent set/delete can't
/// clobber each other.
static SECRETS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_secrets() -> std::collections::BTreeMap<String, String> {
    let Some(p) = secrets_path() else {
        return Default::default();
    };
    // Absent file → empty map (first run, fine). PRESENT-but-corrupt → quarantine
    // the original to `secrets.json.corrupt` before returning empty, so the next
    // write_secrets doesn't overwrite (destroy) a potentially-recoverable file
    // and the user gets a breadcrumb. Mirrors the settings.json + DB handling;
    // without this a truncated secrets.json silently wipes every API key.
    let bytes = match std::fs::read(&p) {
        Ok(b) => b,
        Err(_) => return Default::default(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(map) => map,
        Err(e) => {
            let quarantine = p.with_extension("json.corrupt");
            let _ = std::fs::rename(&p, &quarantine);
            crate::diagnostics::warn_with(
                "settings",
                "secrets.json was corrupt — quarantined to secrets.json.corrupt; \
                 stored API keys must be re-entered",
                serde_json::json!({ "error": e.to_string() }),
            );
            Default::default()
        }
    }
}

/// Atomically persist the secret map as a mode-0600 file (tmp write + rename).
fn write_secrets(map: &std::collections::BTreeMap<String, String>) -> bool {
    let Some(p) = secrets_path() else {
        return false;
    };
    if let Some(parent) = p.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let Ok(json) = serde_json::to_vec_pretty(map) else {
        return false;
    };
    // Unique per-process tmp + O_EXCL create. Sec audit round 2: a fixed-name
    // "secrets.json.tmp" opened with create()+truncate() would (a) REUSE a
    // stale/pre-created tmp and let the final renamed file inherit ITS perms
    // instead of 0600, and (b) FOLLOW a symlink planted at that path, writing
    // the plaintext keys through it. The whole no-Keychain design rests on the
    // file being 0600, so this must hold. create_new (O_EXCL) refuses both: it
    // always makes a fresh file (mode 0600 guaranteed to apply) and fails
    // atomically rather than following a pre-existing symlink.
    let tmp = p.with_extension(format!("json.tmp.{}", std::process::id()));
    // Clear a leftover from a previously-crashed write (removes the symlink
    // itself, not its target) so create_new can succeed on the next line.
    let _ = std::fs::remove_file(&tmp);
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let Ok(mut f) = opts.open(&tmp) else {
        return false;
    };
    if f.write_all(&json).and_then(|_| f.sync_all()).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(f);
    // rename replaces the destination (incl. a symlink AT the dest) atomically
    // without following it. Clean up the tmp if the rename somehow fails.
    if std::fs::rename(&tmp, &p).is_ok() {
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// Masked marker returned to the webview in place of a real API key — the
/// frontend never needs the plaintext, only whether a key is set.
const REDACTED_MARKER: &str = "__keychain__";

/// Test override: when set, keys are kept in-memory instead of touching the
/// real macOS Keychain so the suite never prompts or pollutes the login
/// keychain. Production code never sets this.
fn keychain_disabled() -> bool {
    std::env::var("FROGLIPS_SETTINGS_DIR").is_ok_and(|d| !d.is_empty())
}

/// Store an API key for `account` in the local secret store. Returns true iff
/// the write landed — the caller MUST check before blanking the on-disk
/// plaintext (infra audit M11), else the only copy of the key is lost.
fn keychain_set(account: &str, key: &str) -> bool {
    if keychain_disabled() {
        // Test mode treats success as "do nothing" so the disk path keeps
        // its plaintext (which is the contract the test suite relies on).
        return true;
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_secrets();
    map.insert(account.to_string(), key.to_string());
    if write_secrets(&map) {
        true
    } else {
        crate::diagnostics::warn_with(
            "settings",
            &format!("secret_set({account}) failed"),
            serde_json::json!({ "account": account }),
        );
        false
    }
}

/// Fetch an API key for `account` from the local secret store. `None` if absent.
pub fn keychain_get(account: &str) -> Option<String> {
    if keychain_disabled() {
        return None;
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_secrets()
        .get(account)
        .filter(|s| !s.is_empty())
        .cloned()
}

/// Delete an API key for `account` from the local secret store (best-effort).
fn keychain_delete(account: &str) {
    if keychain_disabled() {
        return;
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_secrets();
    if map.remove(account).is_some() {
        let _ = write_secrets(&map);
    }
}

/// Public wrapper: store a key for `account`. Used by the OpenRouter
/// built-in backend (custom_backend), which keeps its single key in the
/// Keychain rather than in `custom_backends`. Returns true on success.
pub fn keychain_set_account(account: &str, key: &str) -> bool {
    keychain_set(account, key)
}

/// Public wrapper: delete a key for `account`. See `keychain_set_account`.
pub fn keychain_delete_account(account: &str) {
    keychain_delete(account)
}

fn settings_path() -> Option<PathBuf> {
    // Test override: allows the cargo test suite to point at a tempdir without
    // clobbering the developer's real ~/Library/Application Support/Froglips
    // file. Production code never sets this env var.
    if let Ok(dir) = std::env::var("FROGLIPS_SETTINGS_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("settings.json"));
        }
    }
    dirs::config_dir().map(|d| d.join("Froglips/settings.json"))
}

/// Public accessor for the settings.json path — used by the diagnostics
/// bundle exporter to include a (redacted) copy of the file.
pub fn settings_path_for_diagnostics() -> Option<PathBuf> {
    settings_path()
}

/// Load settings with API keys resolved from the Keychain. Performs a
/// one-time migration: any plaintext key still present in settings.json is
/// moved into the Keychain and blanked on disk.
pub fn load() -> Settings {
    let Some(p) = settings_path() else {
        return Settings::default();
    };
    let mut s: Settings = match std::fs::read_to_string(&p) {
        // Missing/unreadable file → fresh defaults (first run). Not an error.
        Err(_) => return Settings::default(),
        Ok(text) => match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            // HIGH-2 (2026-05-29): a corrupt/truncated/hand-broken
            // settings.json used to deserialize to `Settings::default()`,
            // and the next `save` would overwrite the user's real config
            // (workspace_root, custom_backends, mcp_servers, profile) with
            // those defaults — silent total loss. Quarantine the bad file
            // aside FIRST so the original survives for recovery, then boot
            // with defaults against a now-absent path (a fresh file is
            // written on the next save).
            Err(e) => {
                let quarantine = p.with_file_name("settings.json.corrupt");
                let _ = std::fs::rename(&p, &quarantine);
                crate::diagnostics::warn_with(
                    "settings",
                    "settings.json could not be parsed; moved aside to settings.json.corrupt and booted with defaults",
                    serde_json::json!({
                        "error": e.to_string(),
                        "quarantine": quarantine.display().to_string(),
                    }),
                );
                return Settings::default();
            }
        },
    };

    let mut migrated = false;
    if let Some(backends) = s.custom_backends.as_mut() {
        for b in backends.iter_mut() {
            match b.api_key.as_deref() {
                // Already redacted/blank on disk → pull the real key from Keychain.
                Some("") | Some(REDACTED_MARKER) | None => {
                    b.api_key = keychain_get(&b.id);
                }
                // Plaintext key on disk → migrate it into the Keychain.
                // Only mark `migrated` (which triggers the blank-on-disk
                // save below) when the Keychain write actually succeeded —
                // otherwise we'd destroy the only copy of the user's key.
                // Infra audit M11.
                Some(plain) => {
                    let plain_owned = plain.to_string();
                    if keychain_set(&b.id, &plain_owned) {
                        migrated = true;
                    }
                    // Either way, in-memory keeps the real key so the
                    // current session still works. If migration failed
                    // we'll retry next launch.
                }
            }
        }
    }
    if migrated {
        // Persist the blanked-on-disk form; in-memory keeps the real keys.
        let _ = save(&s);
    }
    s
}

/// Serializes settings read-modify-write sequences across IPC commands.
/// `settings_set` / `setup_complete_set` / the agent workspace setter all do
/// load → mutate → save; without a shared lock two near-simultaneous writes
/// each load the same base, mutate different fields, and the second `save`
/// clobbers the first's change (lost update). Callers take this guard for the
/// whole sequence. std::sync::Mutex is fine — the critical section is a file
/// read + JSON munge + atomic write, no `.await` inside. MED (2026-05-29).
static UPDATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the settings update lock. Hold the returned guard across a
/// load → mutate → save sequence. Poison-tolerant (a panic mid-update
/// shouldn't wedge every future settings write).
pub fn lock_for_update() -> std::sync::MutexGuard<'static, ()> {
    UPDATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Persist settings. API keys are written to the macOS Keychain and replaced
/// with an empty placeholder in settings.json so no secret is stored cleartext.
pub fn save(s: &Settings) -> std::io::Result<()> {
    let Some(p) = settings_path() else {
        return Ok(());
    };
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Clone so we can strip keys for disk without disturbing the caller's copy.
    let mut on_disk = s.clone();
    if let Some(backends) = on_disk.custom_backends.as_mut() {
        for b in backends.iter_mut() {
            match b.api_key.take() {
                // A fresh plaintext key → store it. If Keychain refuses,
                // KEEP the plaintext on disk so the key isn't lost —
                // user can re-save once Keychain access is restored.
                // Infra audit M11.
                Some(k) if !k.is_empty() && k != REDACTED_MARKER => {
                    if keychain_set(&b.id, &k) {
                        b.api_key = Some(String::new());
                    } else {
                        b.api_key = Some(k);
                        continue;
                    }
                }
                // The redacted marker means "key unchanged" — leave Keychain as-is.
                Some(k) if k == REDACTED_MARKER => {
                    b.api_key = Some(String::new());
                }
                // Explicitly empty/absent → user cleared the key.
                _ => {
                    keychain_delete(&b.id);
                    b.api_key = Some(String::new());
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&on_disk).unwrap_or_else(|_| "{}".to_string());
    atomic_write(&p, text.as_bytes())
}

/// Write `bytes` to `path` atomically: write to a temp file in the same
/// directory, then rename over the target. A crash mid-write leaves the
/// original file intact rather than truncated — rename is atomic on the
/// same filesystem. Falls back to the temp file's cleanup on rename failure.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // MED (2026-05-29): unique temp name per write. The old `.tmp-{pid}`
    // was shared by every write in the process, so two concurrent saves
    // interleaved their `write_all`s onto the same file and one `rename`d a
    // half-written temp the other was still filling → torn settings.json. A
    // per-write counter gives each its own scratch file.
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".settings.json.tmp-{}-{}", std::process::id(), seq));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Redact API keys for transport to the webview — replaces any present key
/// with a masked marker so the frontend can tell a key is set without ever
/// receiving the plaintext.
pub fn redacted(mut s: Settings) -> Settings {
    if let Some(backends) = s.custom_backends.as_mut() {
        for b in backends.iter_mut() {
            b.api_key = match b.api_key.as_deref() {
                Some(k) if !k.is_empty() => Some(REDACTED_MARKER.to_string()),
                _ => Some(String::new()),
            };
        }
    }
    // NOTE: MCP stdio `env` values are NOT redacted here. They're stored
    // plaintext in settings.json (they must be, to spawn the child) and the UI
    // round-trips the server list through settings_set — masking the value with
    // a marker would be persisted back over the real env on the next save
    // (data loss) without dedicated save-side preserve logic. Severity is low:
    // the values are already on disk, originate from the same renderer, and any
    // actor that can call settings_get can read settings.json directly. The
    // diagnostics bundle (a shareable artifact) DOES redact them.
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the `FROGLIPS_SETTINGS_DIR` env var across parallel tests so two
    /// settings tests don't clobber each other's tempdirs. `std::env::set_var`
    /// is process-global, so serialize via a mutex even though the rest of the
    /// codebase is mostly free of env-mutating tests.
    static ENV_GUARD: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn with_tempdir<F: FnOnce(&std::path::Path)>(f: F) {
        let _g = ENV_GUARD.lock();
        // Stable random-ish path under the OS temp dir; we clean up after.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("froglips-settings-test-{nonce}"));
        std::fs::create_dir_all(&dir).expect("create tempdir");
        // SAFETY: serialized via ENV_GUARD; env mutation is process-global but
        // only test threads holding the guard observe it.
        std::env::set_var("FROGLIPS_SETTINGS_DIR", &dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&dir)));
        std::env::remove_var("FROGLIPS_SETTINGS_DIR");
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// Round-trip the wizard's setup-complete flag through `save → load` to
    /// guarantee the persistence path actually writes + reads the field. This
    /// is the only state the wizard relies on to decide whether to show
    /// itself on launch, so a regression here would re-show the wizard every
    /// startup.
    #[test]
    fn setup_complete_roundtrips_through_disk() {
        with_tempdir(|_dir| {
            // Initial load on a fresh dir → None (legacy/absent → wizard runs).
            let s0 = load();
            assert_eq!(s0.setup_complete, None);

            // Flip to true, persist, reload — must come back true.
            let mut s = s0.clone();
            s.setup_complete = Some(true);
            save(&s).expect("save 1");
            let s1 = load();
            assert_eq!(s1.setup_complete, Some(true));

            // Flip back to false (the "re-run wizard" code path) — same.
            let mut s = s1.clone();
            s.setup_complete = Some(false);
            save(&s).expect("save 2");
            let s2 = load();
            assert_eq!(s2.setup_complete, Some(false));
        });
    }

    /// `atomic_write` must replace the target's contents and must never
    /// leave a `.tmp-` file behind on success.
    #[test]
    fn atomic_write_replaces_contents_cleanly() {
        let dir = std::env::temp_dir().join(format!(
            "froglips-atomic-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("settings.json");

        // Seed an existing file, then atomically overwrite it.
        std::fs::write(&target, b"OLD CONTENTS").unwrap();
        atomic_write(&target, b"NEW CONTENTS").expect("atomic write");
        assert_eq!(std::fs::read(&target).unwrap(), b"NEW CONTENTS");

        // No leftover temp file in the directory.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file leaked: {leftovers:?}");

        // Writing to a brand-new path also works.
        let fresh = dir.join("fresh.json");
        atomic_write(&fresh, b"FRESH").expect("atomic write fresh");
        assert_eq!(std::fs::read(&fresh).unwrap(), b"FRESH");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `save → load` round-trip through the atomic path must preserve data.
    #[test]
    fn save_is_atomic_and_roundtrips() {
        with_tempdir(|_dir| {
            let mut s = Settings {
                theme: Some("dark".into()),
                last_model: Some("test-model".into()),
                ..Default::default()
            };
            save(&s).expect("save");
            let loaded = load();
            assert_eq!(loaded.theme.as_deref(), Some("dark"));
            assert_eq!(loaded.last_model.as_deref(), Some("test-model"));

            // Overwrite — the atomic rename must not corrupt the file.
            s.theme = Some("light".into());
            save(&s).expect("save 2");
            assert_eq!(load().theme.as_deref(), Some("light"));
        });
    }

    /// API keys must never be written cleartext to settings.json, and
    /// `redacted()` must mask any key before it reaches the webview.
    #[test]
    fn api_keys_not_persisted_cleartext_and_redacted() {
        with_tempdir(|dir| {
            let s = Settings {
                custom_backends: Some(vec![CustomBackend {
                    id: "b1".into(),
                    name: "Test".into(),
                    base_url: "https://example.com".into(),
                    model: "m".into(),
                    api_key: Some("sk-secret-value".into()),
                }]),
                ..Default::default()
            };
            save(&s).expect("save");

            // Raw file must not contain the plaintext secret.
            let raw = std::fs::read_to_string(dir.join("settings.json")).expect("read");
            assert!(!raw.contains("sk-secret-value"), "secret leaked to disk");

            // redacted() never exposes the plaintext.
            let r = redacted(s.clone());
            let key = r.custom_backends.unwrap()[0].api_key.clone().unwrap();
            assert_ne!(key, "sk-secret-value");
        });
    }
}
