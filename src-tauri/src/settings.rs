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
    /// Ollama `keep_alive` sent with every local request ("5m"/"30m"/"-1").
    /// Default "30m" (the daemon's own 5m default makes idle reloads of
    /// 20-60GB models painfully common). Absent on legacy installs -> None.
    pub ollama_keep_alive: Option<String>,
    /// Optional MLX speculative-decoding draft model (same tokenizer family
    /// as the main model, e.g. a 0.6B beside a 32B). When set and the
    /// installed mlx_lm.server supports --draft-model, the spawn adds it:
    /// 1.5-2.5x decode on big models, output distribution unchanged.
    pub mlx_draft_model: Option<String>,
    /// Default max RESPONSE tokens for the MLX server (`--max-tokens`). NOTE:
    /// `mlx_lm.server` has no context-window flag — the context length is fixed
    /// by the model's own config — so the only user-settable generation knob is
    /// the default completion length, whose built-in default of 512 truncates
    /// long replies. When set (and the installed server supports the flag), the
    /// spawn passes it. `None` on legacy installs → the server's own default.
    /// A per-request `max_tokens` in the chat call still overrides this default.
    pub mlx_max_tokens: Option<i64>,
    /// Automatic background update checks. Default ON: `None` (legacy files /
    /// fresh installs) and `Some(true)` both enable it; only `Some(false)`
    /// (the Settings → General toggle) opts out. The brief 2026-06 default-off
    /// was for the "vanishing app" probe, whose real cause was a release-script
    /// `ln -sf` Desktop alias breaking the codesign seal (fixed) — not the
    /// updater. The frontend gate (useUpdateCheck) treats absent as enabled, so
    /// keeping this `Option<bool>` needs no migration. Manual check always works.
    pub auto_update_check: Option<bool>,
    /// Backend liveness probe (item 5, 2026-06-13). When enabled (DEFAULT true),
    /// the restart-watcher additionally checks that a ready backend still
    /// answers a lightweight HTTP GET each tick; after N consecutive failures it
    /// declares the backend unresponsive (MLX → eligible for the existing
    /// auto-restart; ollama → surfaced as degraded, never killed). `None` on
    /// legacy files → treated as enabled. Set `Some(false)` to disable.
    pub backend_liveness_probe: Option<bool>,
    /// User-registered APIs the agent can call by name via `call_api`. Keys
    /// live in the Keychain (account "api:{id}"); never in chat.
    pub saved_apis: Option<Vec<SavedApi>>,
    /// Max agent tool-turns per run. `None` → the runner default (80). The
    /// frontend clamps to [5, 400]. Raise for long multi-file builds.
    pub agent_max_iterations: Option<i64>,
    /// Global cap on subagents running concurrently across the whole process
    /// (item 2). `None` → the frontend default (4). Bounds fan-out BREADTH so a
    /// wide subagent tree can't launch unbounded concurrent inference loops.
    pub max_concurrent_subagents: Option<i64>,
    /// Local-inference admission permits (item 1). `None` → 1 (serialize local
    /// inference so a fan-out doesn't thrash a single GPU/CPU). Cloud routes
    /// bypass the gate. Frontend clamps to >= 1.
    pub inference_permits: Option<i64>,
    /// Beginner "Simple mode" (W5B). When `Some(true)`, the agent toolbar +
    /// settings panel collapse the 47-tool firehose and advanced knobs to a
    /// curated minimal set, hiding the rest behind an Advanced expander. `None`
    /// on legacy files / fresh installs and `Some(false)` both mean OFF —
    /// today's full advanced UI — so existing users never suddenly lose
    /// controls. Toggled from the in-app Simple/Advanced control. Rides
    /// settings.json via serde(default); no DB migration.
    pub simple_mode: Option<bool>,
    /// Cached machine profile (RAM / cores / CPU) detected once on first launch
    /// and refreshed weekly, so the model picker and onboarding can size models
    /// to the hardware without re-probing sysctl every render. Absent on legacy
    /// installs → `None` → re-detected on next mount. No DB migration — rides
    /// settings.json via serde(default).
    pub hardware_profile: Option<HardwareProfile>,
    /// DB/storage maintenance policy (WS4, 2026-06-13). `None` on legacy files →
    /// the maintenance agent uses `MaintenanceConfig::default()` (safe phases
    /// enabled, archive-not-delete, no auto-VACUUM). Rides settings.json via
    /// serde(default); no DB migration. Old files load unchanged.
    pub maintenance: Option<MaintenanceConfig>,
    /// Built-in tools the user has switched OFF in the Skills & Tools hub. A
    /// GLOBAL list of tool names (e.g. "run_shell", "delete_path") that the
    /// agent-loop excludes from the system prompt's available-tools section, on
    /// top of the per-preset allowlist (this only ever FURTHER restricts).
    /// `None`/absent (legacy files, fresh installs) → empty → all tools enabled,
    /// i.e. today's behavior. Rides settings.json via serde(default); no DB
    /// migration.
    pub disabled_tools: Option<Vec<String>>,
    /// Gated macOS "Computer Use" mode (2026-06-16): when `Some(true)` the agent
    /// loop advertises + permits the cu_* desktop-control tools (screenshot →
    /// mouse/keyboard/scroll). Default OFF — `None` (legacy/fresh) and
    /// `Some(false)` both mean disabled; it is an explicit per-machine opt-in on
    /// top of the per-call confirmation modal and macOS Accessibility TCC. Rides
    /// settings.json via serde(default); no DB migration.
    pub computer_use_enabled: Option<bool>,
    /// HIGH-2 (2026-05-29): forward-compatibility capture. Any top-level key
    /// this build doesn't recognise (because it was written by a NEWER build)
    /// is parked here and re-serialized verbatim on save, so opening an old
    /// build can't silently destroy a newer build's settings. Skipped when
    /// empty so it never appears in a fresh file.
    /// Messaging gateway config (2026-06-16): per-channel enable + allowed-sender
    /// allowlist for running the agent over chat platforms. Bot tokens live in the
    /// Keychain (key `messaging:<channel>`), NOT here. Absent (legacy/fresh) →
    /// gateway off. Declared before the flatten `extra` so serde captures it as a
    /// real key, not into the forward-compat bag.
    #[serde(default)]
    pub messaging: MessagingConfig,
    /// Anonymizing egress proxy (2026-06-23): when set, ALL outbound HTTP (web
    /// tools, cloud model APIs, HuggingFace, MCP, updater) routes through this
    /// proxy URL — typically Tor (`socks5h://127.0.0.1:9050`). Loopback is never
    /// proxied, so local Ollama/MLX backends keep working. `None`/empty = direct.
    /// Applied to the `net` factory on load + save. See `net.rs` for the (honest)
    /// scope + limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_proxy: Option<String>,
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Cached snapshot of the host machine — RAM, core counts, CPU brand — plus the
/// unix-seconds timestamp it was detected at (so a stale profile re-detects).
/// Mirrors the live `system_info()` command result + `detected_at`.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct HardwareProfile {
    pub total_ram_gb: f64,
    pub physical_cores: u32,
    pub performance_cores: u32,
    pub cpu_brand: String,
    pub detected_at: i64,
}

/// Messaging gateway config. One entry per chat platform; v1 ships Telegram.
/// Bot tokens are NOT stored here (Keychain `messaging:<channel>`); this holds
/// only the enable flag + the allowed-sender allowlist.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct MessagingConfig {
    pub telegram: TelegramChannel,
    pub matrix: MatrixChannel,
    pub discord: DiscordChannel,
    pub slack: SlackChannel,
    pub mattermost: MattermostChannel,
    pub email: EmailChannel,
}

// `allowed_user_ids` is the SAFETY gate on every channel: the gateway refuses
// to start with an empty allowlist (an empty list would let anyone who finds
// the bot drive the agent). Secrets (tokens/passwords) live in the Keychain
// (`messaging:<channel>`), never here — these structs hold only the enable
// flag, the allowlist, and non-secret connection fields.

/// Telegram: numeric user IDs from @userinfobot.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct TelegramChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
}

/// Matrix: `homeserver` base URL (e.g. https://matrix.org); access token in
/// Keychain. `bot_user_id` (the bot's own @user:server) is used to skip echo.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct MatrixChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
    pub homeserver: String,
    pub bot_user_id: String,
}

/// Discord: bot token in Keychain; allowlist is numeric user IDs.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct DiscordChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
}

/// Slack: Socket Mode needs two secrets — store as `app_token|bot_token` in the
/// Keychain (xapp- for the WS, xoxb- for postMessage). Allowlist = Slack user IDs.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct SlackChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
}

/// Mattermost: `server_url` (https://your.server); bot token in Keychain.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct MattermostChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
    pub server_url: String,
}

/// Email: IMAP receive + SMTP send. Password in Keychain. Allowlist = sender
/// addresses.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct EmailChannel {
    pub enabled: bool,
    pub allowed_user_ids: Vec<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub username: String,
}

/// DB/storage maintenance policy (WS4). All fields carry conservative
/// defaults via `#[serde(default = …)]` so an old settings.json (which lacks
/// the whole `maintenance` block, or any individual field a newer build adds)
/// deserializes into the safe configuration. `Default` matches those defaults
/// so `maintenance: None` and an explicit all-defaults block behave identically.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct MaintenanceConfig {
    /// Master switch for the SAFE maintenance phases (caps, archive, reclaim).
    /// VACUUM is never run by the timer regardless — only via the explicit
    /// opt-in command. Default on.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Move messages older than `archive_age_days` to the cold archive DB
    /// instead of leaving them in the hot DB. Default on (archive, never
    /// delete — fully recoverable via `db_maintenance_restore_archived`).
    #[serde(default = "default_true")]
    pub archive_messages: bool,
    /// Age threshold (days) for archiving a message. Default 365.
    #[serde(default = "default_archive_age_days")]
    pub archive_age_days: i64,
    /// A conversation with any activity (newest message) within this many
    /// seconds is NEVER archived, even if some of its messages are old.
    /// Default 86400 (1 day).
    #[serde(default = "default_active_window_secs")]
    pub active_window_secs: i64,
    /// When true, archived rows are also hard-deleted from the archive DB after
    /// `archive_retention_days`. Default FALSE — archive-not-delete is the
    /// contract; a privacy-conscious user opts in to genuine deletion.
    #[serde(default)]
    pub hard_delete_archived: bool,
    /// Retention window (days) for `hard_delete_archived`: an archived row is
    /// hard-deleted only once it has lived in the archive at least this long.
    /// Default 365 (conservative). Ignored unless `hard_delete_archived`.
    #[serde(default = "default_archive_retention_days")]
    pub archive_retention_days: i64,
    /// Run a full `VACUUM` automatically. Default FALSE — VACUUM rewrites the
    /// whole DB and takes a global lock; it only runs via the explicit
    /// `db_maintenance_vacuum` command.
    #[serde(default)]
    pub auto_vacuum: bool,
    /// Minimum hours between scheduled maintenance passes. Default 6.
    #[serde(default = "default_idle_interval_hours")]
    pub idle_interval_hours: u64,
}

fn default_archive_age_days() -> i64 {
    365
}
fn default_archive_retention_days() -> i64 {
    365
}
fn default_active_window_secs() -> i64 {
    86_400
}
fn default_idle_interval_hours() -> u64 {
    6
}

impl Default for MaintenanceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            archive_messages: true,
            archive_age_days: default_archive_age_days(),
            active_window_secs: default_active_window_secs(),
            hard_delete_archived: false,
            archive_retention_days: default_archive_retention_days(),
            auto_vacuum: false,
            idle_interval_hours: default_idle_interval_hours(),
        }
    }
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SavedApi {
    pub id: String,
    pub name: String,
    /// Scheme+host(+optional base path), e.g. "https://api.github.com". The
    /// agent supplies only a relative path, so it can never be steered off
    /// this host.
    pub base_url: String,
    /// Header the key is injected into (default "Authorization").
    #[serde(default = "default_auth_header")]
    pub auth_header: String,
    /// Value template with `{key}` substituted from the Keychain, e.g.
    /// "Bearer {key}" or "token {key}". If it lacks `{key}` the raw key is
    /// appended.
    #[serde(default = "default_auth_template")]
    pub auth_template: String,
    pub description: Option<String>,
    /// Keychain-backed; redacted on disk like custom_backends. Account
    /// namespace "api:{id}".
    pub api_key: Option<String>,
}

fn default_auth_header() -> String {
    "Authorization".to_string()
}
fn default_auth_template() -> String {
    "Bearer {key}".to_string()
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

/// FALLBACK secret store: a mode-0600 JSON file (account → key) next to
/// settings.json. As of audit A28 the default backend is the macOS Keychain
/// (`keychain_*` above); this file is used only when the user reverts via
/// FROGLIPS_SECRETS_FILE=1, when a Keychain op fails (so a key is never lost),
/// and as the migration source on first Keychain read. Original no-Keychain
/// rationale (2026-06-02): the Keychain ACL reset on every ad-hoc re-sign,
/// re-prompting despite "Always Allow" — resolved now that releases ship under
/// a stable notarized Developer ID signature. File stays mode 0600 throughout.
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
    // Audit A28: this store is deliberately a mode-0600 file (not Keychain —
    // see above). Defensively re-assert 0600 on load: a backup/restore, a
    // manual edit, or a umask quirk could have left it group/other-readable,
    // exposing API keys to other users. Tighten it back if so.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
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

/// Whether to keep API keys in a 0600 file instead of the macOS Keychain.
/// L16: this used to key off `FROGLIPS_SETTINGS_DIR`, so relocating the config
/// directory in PRODUCTION silently downgraded secret storage from the Keychain
/// to a plaintext file. Decoupled: the test build (`cfg!(test)`) never touches
/// the real Keychain (no prompts / no login-keychain pollution), and a
/// production user must opt out explicitly via the dedicated
/// `FROGLIPS_DISABLE_KEYCHAIN` var. Relocating config no longer changes the
/// secret backend.
fn keychain_disabled() -> bool {
    cfg!(test) || std::env::var("FROGLIPS_DISABLE_KEYCHAIN").is_ok_and(|d| !d.is_empty())
}

/// Keychain service name for all Froglips API-key items (audit A28).
const KC_SERVICE: &str = "Froglips";

/// True when the Keychain backend is active. Off only when the user reverts to
/// the 0600 file via FROGLIPS_SECRETS_FILE=1 (escape hatch for the prompt churn
/// that drove the original file choice — on a notarized stable signature the
/// ACL should persist, but the file fallback is always there). Test mode is
/// handled separately by `keychain_disabled` at each call site.
fn use_keychain_backend() -> bool {
    !std::env::var("FROGLIPS_SECRETS_FILE").is_ok_and(|v| !v.is_empty())
}

/// Store an API key for `account`. Returns true iff the write landed — the
/// caller MUST check before blanking any on-disk plaintext (infra audit M11),
/// else the only copy of the key is lost. Default backend is the macOS Keychain
/// (A28); a Keychain failure falls back to the 0600 file so a key is never
/// dropped on the floor.
fn keychain_set(account: &str, key: &str) -> bool {
    if keychain_disabled() {
        // Test/disabled mode: never touch the real Keychain, but DO persist to
        // the 0600 file so set/get/delete stay symmetric and the secret can be
        // resolved later (the integration surface exercises real resolution).
        // Previously this was a pure no-op that stored nothing, which — paired
        // with save() blanking the on-disk plaintext on a "success" return —
        // made the key unrecoverable and keychain_get always None (bug, low).
        let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load_secrets();
        map.insert(account.to_string(), key.to_string());
        return write_secrets(&map);
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if use_keychain_backend() {
        match security_framework::passwords::set_generic_password(
            KC_SERVICE,
            account,
            key.as_bytes(),
        ) {
            Ok(()) => {
                // Purge any legacy plaintext copy now the Keychain holds it.
                let mut map = load_secrets();
                if map.remove(account).is_some() {
                    let _ = write_secrets(&map);
                }
                return true;
            }
            Err(e) => {
                crate::diagnostics::warn_with(
                    "settings",
                    &format!("keychain_set({account}) failed — falling back to 0600 file"),
                    serde_json::json!({ "account": account, "error": e.to_string() }),
                );
                // fall through to the file backend
            }
        }
    }
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

/// Fetch an API key for `account`. `None` if absent. On the Keychain backend a
/// miss transparently migrates any legacy 0600-file copy INTO the Keychain (and
/// purges the file copy) so existing installs upgrade on first read.
pub fn keychain_get(account: &str) -> Option<String> {
    keychain_get_cached(account, None)
}

/// Resolution core for `keychain_get`. `file_cache`, when `Some`, is a secrets
/// snapshot the caller already read this pass — used to satisfy the FILE-backed
/// read paths (disabled mode, non-Keychain backend, Keychain-miss migration
/// source) WITHOUT re-reading/re-stat'ing secrets.json per entry (perf, low:
/// `load()` resolves N backends + M APIs and otherwise paid N+M file reads).
/// `None` falls back to `load_secrets()`, preserving the standalone contract.
/// Migration WRITES always re-load fresh under the lock so the on-disk purge
/// stays correct under concurrency; the cache only short-circuits reads.
fn keychain_get_cached(
    account: &str,
    file_cache: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<String> {
    let from_cache = |map: &std::collections::BTreeMap<String, String>| {
        map.get(account).filter(|s| !s.is_empty()).cloned()
    };
    if keychain_disabled() {
        // Symmetric with keychain_set's disabled-mode path: resolve from the
        // 0600 file backend instead of returning None unconditionally, so the
        // set→get round-trip works under FROGLIPS_SETTINGS_DIR (bug, low).
        return match file_cache {
            Some(map) => from_cache(map),
            None => {
                let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                from_cache(&load_secrets())
            }
        };
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if use_keychain_backend() {
        if let Ok(bytes) = security_framework::passwords::get_generic_password(KC_SERVICE, account)
        {
            // Real Keychain hit. Self-heal: opportunistically purge any stale
            // 0600-file copy left behind by a migration whose write_secrets()
            // failed (bug, low) — a BTreeMap lookup that's cheap on the common
            // path (load_secrets returns empty once migration is complete).
            let val = String::from_utf8(bytes).ok().filter(|s| !s.is_empty());
            if val.is_some() {
                let mut map = load_secrets();
                if map.remove(account).is_some() {
                    let _ = write_secrets(&map);
                }
            }
            return val;
        }
        // Not in the Keychain (or access failed) — migrate from the legacy file.
        let from_file = match file_cache {
            Some(map) => from_cache(map),
            None => from_cache(&load_secrets()),
        };
        if let Some(v) = from_file {
            if security_framework::passwords::set_generic_password(
                KC_SERVICE,
                account,
                v.as_bytes(),
            )
            .is_ok()
            {
                let mut map = load_secrets();
                if map.remove(account).is_some() {
                    let _ = write_secrets(&map);
                }
            }
            return Some(v);
        }
        return None;
    }
    match file_cache {
        Some(map) => from_cache(map),
        None => from_cache(&load_secrets()),
    }
}

/// Delete an API key for `account` (best-effort). Removes from BOTH the Keychain
/// and any legacy file copy so a delete can't leave a stale plaintext behind.
fn keychain_delete(account: &str) {
    if keychain_disabled() {
        // Test/disabled mode: delete from the 0600 file backend (the only store
        // set/get use in this mode) so delete stays symmetric with them (bug,
        // low). Never touch the real Keychain.
        let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = load_secrets();
        if map.remove(account).is_some() {
            let _ = write_secrets(&map);
        }
        return;
    }
    let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if use_keychain_backend() {
        let _ = security_framework::passwords::delete_generic_password(KC_SERVICE, account);
    }
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

    // Perf (low): read the 0600 secrets file ONCE for this whole resolution
    // pass instead of once per blank/redacted entry. Each entry's file-backed
    // read (disabled mode, file backend, or Keychain-miss migration source)
    // shares this snapshot; only Keychain round-trips and migration writes still
    // hit per entry, which is inherent. Snapshot under the same lock the helpers
    // use. Skipped entirely when there are no secret-bearing entries to resolve.
    let needs_resolution = s.custom_backends.as_ref().is_some_and(|v| !v.is_empty())
        || s.saved_apis.as_ref().is_some_and(|v| !v.is_empty());
    let file_cache = if needs_resolution {
        let _g = SECRETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Some(load_secrets())
    } else {
        None
    };
    let file_cache = file_cache.as_ref();

    let mut migrated = false;
    if let Some(backends) = s.custom_backends.as_mut() {
        for b in backends.iter_mut() {
            match b.api_key.as_deref() {
                // Already redacted/blank on disk → pull the real key from Keychain.
                Some("") | Some(REDACTED_MARKER) | None => {
                    b.api_key = keychain_get_cached(&b.id, file_cache);
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
    if let Some(apis) = s.saved_apis.as_mut() {
        for a in apis.iter_mut() {
            let acct = format!("api:{}", a.id);
            match a.api_key.as_deref() {
                Some("") | Some(REDACTED_MARKER) | None => {
                    a.api_key = keychain_get_cached(&acct, file_cache);
                }
                Some(plain) => {
                    let plain_owned = plain.to_string();
                    if keychain_set(&acct, &plain_owned) {
                        migrated = true;
                    }
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
    // Apply the anonymizing proxy immediately so new HTTP clients pick it up
    // without a restart (long-lived Lazy clients still need one — see net.rs).
    crate::net::set_proxy(s.web_proxy.clone());
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
    if let Some(apis) = on_disk.saved_apis.as_mut() {
        for a in apis.iter_mut() {
            let acct = format!("api:{}", a.id);
            match a.api_key.take() {
                Some(k) if !k.is_empty() && k != REDACTED_MARKER => {
                    if keychain_set(&acct, &k) {
                        a.api_key = Some(String::new());
                    } else {
                        a.api_key = Some(k);
                        continue;
                    }
                }
                Some(k) if k == REDACTED_MARKER => {
                    a.api_key = Some(String::new());
                }
                _ => {
                    keychain_delete(&acct);
                    a.api_key = Some(String::new());
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
    // saved_apis carry `call_api` registry keys (GitHub PATs, etc.). `load()`
    // resolves these from the Keychain into plaintext, so they MUST be masked
    // here too — otherwise `settings_get` would ship real credentials to the
    // webview (sec review 2026-06 HIGH). save() treats REDACTED_MARKER as
    // "unchanged", so the masked marker round-trips losslessly.
    if let Some(apis) = s.saved_apis.as_mut() {
        for a in apis.iter_mut() {
            a.api_key = match a.api_key.as_deref() {
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

    /// MLX tuning knobs (W2-MODELS items 2+3) round-trip through disk, and a
    /// legacy file lacking them deserializes to `None` (server defaults).
    #[test]
    fn mlx_tuning_roundtrips_and_back_compat() {
        with_tempdir(|dir| {
            // Legacy file without either key → None (server defaults apply).
            std::fs::write(dir.join("settings.json"), r#"{ "theme": "dark" }"#)
                .expect("write legacy");
            let s = load();
            assert!(s.mlx_draft_model.is_none());
            assert!(s.mlx_max_tokens.is_none());

            // Explicit values survive save → load.
            let s2 = Settings {
                mlx_draft_model: Some("qwen2.5-0.5b".into()),
                mlx_max_tokens: Some(4096),
                ..Default::default()
            };
            save(&s2).expect("save");
            let back = load();
            assert_eq!(back.mlx_draft_model.as_deref(), Some("qwen2.5-0.5b"));
            assert_eq!(back.mlx_max_tokens, Some(4096));
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

    /// WS4: an OLD settings.json that lacks the `maintenance` block (and a
    /// block missing individual fields a newer build adds) must load cleanly —
    /// `maintenance` deserializes to `None`/conservative defaults, never errors,
    /// and a save round-trips the explicit config back.
    #[test]
    fn maintenance_config_back_compat_and_roundtrip() {
        with_tempdir(|dir| {
            // Legacy file with NO maintenance key at all.
            std::fs::write(
                dir.join("settings.json"),
                r#"{ "theme": "dark", "auto_update_check": false }"#,
            )
            .expect("write legacy settings");
            let s = load();
            assert!(s.maintenance.is_none(), "absent block → None");
            // The agent's effective config is the safe default.
            let eff = s.maintenance.unwrap_or_default();
            assert!(eff.enabled);
            assert!(eff.archive_messages);
            assert!(!eff.auto_vacuum);
            assert!(!eff.hard_delete_archived);
            assert_eq!(eff.archive_age_days, 365);
            assert_eq!(eff.active_window_secs, 86_400);
            assert_eq!(eff.idle_interval_hours, 6);

            // A PARTIAL block (only `enabled`) fills the rest from defaults.
            std::fs::write(
                dir.join("settings.json"),
                r#"{ "maintenance": { "enabled": false } }"#,
            )
            .expect("write partial");
            let p = load().maintenance.expect("partial block parses");
            assert!(!p.enabled);
            assert!(p.archive_messages, "missing field → default true");
            assert_eq!(p.archive_age_days, 365);

            // Explicit config survives save → load.
            let s2 = Settings {
                maintenance: Some(MaintenanceConfig {
                    enabled: true,
                    archive_messages: true,
                    archive_age_days: 30,
                    active_window_secs: 3600,
                    hard_delete_archived: false,
                    archive_retention_days: 365,
                    auto_vacuum: false,
                    idle_interval_hours: 12,
                }),
                ..Default::default()
            };
            save(&s2).expect("save");
            let back = load().maintenance.expect("roundtrip");
            assert_eq!(back.archive_age_days, 30);
            assert_eq!(back.idle_interval_hours, 12);
        });
    }

    /// Regression for the test-mode keychain asymmetry (bug, low): under
    /// FROGLIPS_SETTINGS_DIR, `keychain_set` used to be a pure no-op and
    /// `keychain_get` returned `None` unconditionally, so a saved key was
    /// unrecoverable and the integration surface could never exercise real
    /// secret resolution. After the fix the set→get round-trip must work, and
    /// `load()` must re-resolve the key the save blanked on disk.
    #[test]
    fn keychain_roundtrips_in_test_mode() {
        with_tempdir(|dir| {
            // Direct set→get round-trip via the disabled-mode file backend.
            assert!(keychain_set("api:rt", "sk-roundtrip"));
            assert_eq!(keychain_get("api:rt").as_deref(), Some("sk-roundtrip"));

            // End-to-end: save() blanks the on-disk plaintext, load() resolves
            // it back from the file backend (was None before the fix).
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

            // Plaintext is gone from settings.json...
            let raw = std::fs::read_to_string(dir.join("settings.json")).expect("read");
            assert!(!raw.contains("sk-secret-value"), "secret leaked to disk");

            // ...but load() resolves the real key back from the file backend.
            let loaded = load();
            let resolved = loaded.custom_backends.unwrap()[0].api_key.clone();
            assert_eq!(resolved.as_deref(), Some("sk-secret-value"));

            // delete() clears it from the file backend too.
            keychain_delete("b1");
            assert_eq!(keychain_get("b1"), None);
        });
    }
}
