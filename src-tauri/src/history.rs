use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use r2d2::{ManageConnection, Pool, PooledConnection};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

/* ── Connection pool ── */

pub(crate) struct SqliteManager {
    path: PathBuf,
}

impl ManageConnection for SqliteManager {
    type Connection = Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;",
        )?;
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Connection) -> rusqlite::Result<()> {
        // Cheap liveness probe — fails fast if the connection is dead.
        conn.execute_batch("SELECT 1")
    }

    fn has_broken(&self, conn: &mut Connection) -> bool {
        // A connection is broken if it can no longer run a trivial query.
        conn.execute_batch("SELECT 1").is_err()
    }
}

/// Lazy-built connection pool. Wrapped in a `Result` so a failure to build the
/// pool (disk full, permission denied on `~/.local-llm-app`, corrupt DB that
/// quarantine couldn't move aside, etc.) is *captured* rather than panicking
/// the whole app at first DB touch. `get_db()` surfaces the failure as a
/// regular `Err` so the UI can show "DB unavailable" instead of crashing, and
/// `db_unavailable_notice()` exposes the message for an IPC banner.
static DB: Lazy<Result<Pool<SqliteManager>, String>> =
    Lazy::new(|| build_pool().map_err(|e| e.to_string()));

/// Set when a corrupt DB was detected and quarantined on startup. Holds the
/// path the corrupt file was renamed to so a command can surface it.
static DB_RECOVERY: RwLock<Option<String>> = RwLock::new(None);

/// If a corrupt DB was quarantined this run, returns the path of the renamed
/// corrupt file. `None` means the DB opened cleanly.
pub fn recovery_notice() -> Option<String> {
    DB_RECOVERY.read().clone()
}

/// If the DB pool failed to build (disk full, permission denied, etc.),
/// returns the underlying error string for surfacing in the UI. `None` means
/// the pool is healthy. Safe to call from any IPC command — never panics.
///
/// Intended caller: an IPC command (e.g. `db_unavailable_notice`) that the
/// frontend probes on app boot to show a "DB unavailable" banner instead of
/// every history-touching command failing with a generic error. Marked
/// `allow(dead_code)` so the structured-error mechanism lands even before
/// the command wrapper is wired (the panic-on-startup behaviour it replaces
/// is the higher-severity risk).
#[allow(dead_code)]
pub fn db_unavailable_notice() -> Option<String> {
    match &*DB {
        Ok(_) => None,
        Err(e) => Some(e.clone()),
    }
}

pub(crate) fn db_path() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let base = home.join(".local-llm-app");
    std::fs::create_dir_all(&base).context("failed to create ~/.local-llm-app")?;
    Ok(base.join("db.sqlite"))
}

/// RFC3339-ish UTC timestamp safe for use in a filename (no colons).
fn quarantine_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Reuse the colon-free convention: YYYYMMDDTHHMMSSZ.
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}{m:02}{d:02}T{hh:02}{mm:02}{ss:02}Z")
}

/// Run `PRAGMA integrity_check` on the DB at `path`. Returns `true` when the
/// DB is healthy ("ok"), `false` when corruption is detected. A DB that cannot
/// even be opened is treated as corrupt so it gets quarantined.
fn integrity_ok(path: &Path) -> bool {
    if !path.exists() {
        // A non-existent DB is fine — schema setup will create a fresh one.
        return true;
    }
    let conn = match Connection::open(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(s) => s == "ok",
        Err(_) => false,
    }
}

/// Rename a corrupt DB (and its `-wal`/`-shm` siblings) out of the way so
/// schema setup can build a fresh DB in its place. Records the quarantine
/// location in `DB_RECOVERY`. Best-effort on the siblings — they may not exist.
fn quarantine_corrupt_db(path: &Path) -> Result<()> {
    let stamp = quarantine_stamp();
    let corrupt = {
        let mut s = path.as_os_str().to_owned();
        s.push(format!(".corrupt-{stamp}"));
        PathBuf::from(s)
    };
    std::fs::rename(path, &corrupt)
        .with_context(|| format!("failed to quarantine corrupt db to {}", corrupt.display()))?;
    for suffix in ["-wal", "-shm"] {
        let mut sib = path.as_os_str().to_owned();
        sib.push(suffix);
        let sib = PathBuf::from(sib);
        if sib.exists() {
            let mut dst = corrupt.as_os_str().to_owned();
            dst.push(suffix);
            let _ = std::fs::rename(&sib, PathBuf::from(dst));
        }
    }
    let notice = corrupt.display().to_string();
    crate::diagnostics::error_with(
        "db",
        "corrupt database detected on startup — quarantined and recreated",
        serde_json::json!({ "quarantined_to": notice }),
    );
    *DB_RECOVERY.write() = Some(notice);
    Ok(())
}

/// A single rung of the numbered migration ladder. `version` is the
/// `PRAGMA user_version` value the DB advances to once `apply` succeeds; the
/// ladder runs every step whose version is greater than the current
/// `user_version`, in ascending order, each inside its own transaction.
///
/// Every `apply` body must be idempotent on its own — an old-shape DB sits at
/// `user_version = 0` even if some columns already exist (the pre-ladder
/// ad-hoc migrations never recorded a version), so a step may re-run against
/// a schema that already has its changes. `CREATE … IF NOT EXISTS` and the
/// `pragma_table_info` column guards keep that safe.
struct Migration {
    version: i64,
    apply: fn(&Connection) -> Result<()>,
}

/// Whether `table` has a column named `column`. Used by ladder steps to make
/// `ALTER TABLE ADD COLUMN` idempotent (SQLite has no `ADD COLUMN IF NOT
/// EXISTS`).
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let q = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1");
    match conn.query_row(&q, params![column], |_| Ok(true)) {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(anyhow::anyhow!(
            "pragma_table_info({table}.{column}) failed: {e}"
        )),
    }
}

/// The ordered migration ladder. The highest `version` here is the target
/// schema — both a fresh DB and any older DB converge to it. Steps must only
/// ever be appended; never reorder or renumber an existing rung.
const MIGRATIONS: &[Migration] = &[
    // v1 — base tables. The original schema before versioning existed.
    Migration {
        version: 1,
        apply: |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    model TEXT,
                    created_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
                 CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
                    source_msg_id INTEGER,
                    tags TEXT NOT NULL DEFAULT '',
                    embedding BLOB,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
                 CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conversation_id);",
            )?;
            Ok(())
        },
    },
    // v2 — messages.model: per-message model attribution.
    Migration {
        version: 2,
        apply: |conn| {
            if !column_exists(conn, "messages", "model")? {
                conn.execute("ALTER TABLE messages ADD COLUMN model TEXT", [])?;
            }
            Ok(())
        },
    },
    // v3 — messages.images: JSON-encoded `ChatImage[]` for vision attachments.
    Migration {
        version: 3,
        apply: ensure_messages_images_column,
    },
    // v4 — memories scope columns: scope ('global'|'project'|'conversation')
    // and project_root, plus the scope index.
    Migration {
        version: 4,
        apply: ensure_memory_scope_columns,
    },
    // v5 — conversation fork columns: parent_conv_id, parent_message_id and
    // the parent index — branch/fork lineage tracking.
    Migration {
        version: 5,
        apply: ensure_conversation_fork_columns,
    },
    // v6 — conversations.params: nullable JSON object of per-conversation
    // model params { temperature, top_p, max_tokens, system_prompt }.
    Migration {
        version: 6,
        apply: ensure_conversation_params_column,
    },
    // v7 — conversation organization: pinned (0/1) + tags (JSON array string).
    Migration {
        version: 7,
        apply: ensure_conversation_org_columns,
    },
    // v8 — Workflows feature: `workflows` + `workflow_runs` tables.
    Migration {
        version: 8,
        apply: crate::workflows::ensure_workflow_tables,
    },
    // v9 — `workflow_card_fired.workflow_id`: an INTEGER column so
    // `delete_workflow` can delete by equality rather than a `card_key LIKE
    // '<id>:%'` pattern that would over-match (e.g. for id=1 a row keyed
    // `10:foo` was a false positive). Backfills the column by parsing the
    // integer prefix out of each existing card_key.
    Migration {
        version: 9,
        apply: crate::workflows::ensure_card_fired_workflow_id_column,
    },
];

/// Target schema version — the highest rung of the ladder.
#[cfg(test)]
fn latest_version() -> i64 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

/// Run the migration ladder against `conn`. Steps whose `version` exceeds the
/// DB's current `PRAGMA user_version` are applied in ascending order, each in
/// its own transaction; `user_version` is advanced after each rung commits.
/// Running this against an up-to-date DB is a no-op.
fn run_migrations(conn: &Connection) -> Result<()> {
    let mut current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for m in MIGRATIONS {
        if m.version <= current {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        let stepped = (|| -> Result<()> {
            (m.apply)(conn)?;
            // `user_version` cannot be parameterised — the value is a ladder
            // constant, never user input, so the format is safe.
            conn.execute_batch(&format!("PRAGMA user_version = {}", m.version))?;
            Ok(())
        })();
        match stepped {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                current = m.version;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.context(format!("migration to v{} failed", m.version)));
            }
        }
    }
    Ok(())
}

fn setup_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    // Numbered migration ladder keyed on PRAGMA user_version. A fresh DB runs
    // every rung from 0; an existing DB runs only the rungs above its recorded
    // version. Both converge on `latest_version()`.
    run_migrations(conn)?;
    // Install audit table (idempotent — CREATE TABLE IF NOT EXISTS).
    crate::agent_audit::ensure_schema(conn)?;
    // Install RAG tables (idempotent).
    crate::rag::ensure_schema(conn)?;
    Ok(())
}

/// Idempotently add the `images` JSON column to the `messages` table. Detects
/// via `pragma_table_info` so re-runs on an upgraded schema are no-ops.
pub(crate) fn ensure_messages_images_column(conn: &Connection) -> Result<()> {
    let has: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'images'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("pragma_table_info(images) failed: {e}")),
    };
    if !has {
        conn.execute("ALTER TABLE messages ADD COLUMN images TEXT", [])?;
    }
    Ok(())
}

/// Idempotently add scope columns to the `memories` table. Detects each
/// column via `pragma_table_info` before running `ALTER TABLE`.
pub(crate) fn ensure_memory_scope_columns(conn: &Connection) -> Result<()> {
    let has_col = |name: &str| -> Result<bool> {
        match conn.query_row(
            "SELECT 1 FROM pragma_table_info('memories') WHERE name = ?1",
            params![name],
            |_| Ok(true),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(anyhow::anyhow!("pragma_table_info failed: {e}")),
        }
    };
    if !has_col("scope")? {
        conn.execute(
            "ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
            [],
        )?;
    }
    if !has_col("project_root")? {
        conn.execute("ALTER TABLE memories ADD COLUMN project_root TEXT", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)",
        [],
    )?;
    Ok(())
}

/// Idempotently add fork tracking columns to the `conversations` table.
/// Detects each column via `pragma_table_info` before running `ALTER TABLE`.
pub(crate) fn ensure_conversation_fork_columns(conn: &Connection) -> Result<()> {
    let has_col = |name: &str| -> Result<bool> {
        match conn.query_row(
            "SELECT 1 FROM pragma_table_info('conversations') WHERE name = ?1",
            params![name],
            |_| Ok(true),
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(anyhow::anyhow!("pragma_table_info failed: {e}")),
        }
    };
    if !has_col("parent_conv_id")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN parent_conv_id INTEGER",
            [],
        )?;
    }
    if !has_col("parent_message_id")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN parent_message_id INTEGER",
            [],
        )?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conv_id)",
        [],
    )?;
    Ok(())
}

/// Idempotently add the `params` JSON column to the `conversations` table.
/// Detects via `pragma_table_info` so re-runs on an upgraded schema are no-ops.
pub(crate) fn ensure_conversation_params_column(conn: &Connection) -> Result<()> {
    let has: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'params'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("pragma_table_info(params) failed: {e}")),
    };
    if !has {
        conn.execute("ALTER TABLE conversations ADD COLUMN params TEXT", [])?;
    }
    Ok(())
}

/// Idempotently add the conversation-organization columns to `conversations`:
/// `pinned` (INTEGER 0/1, default 0) and `tags` (nullable TEXT holding a JSON
/// array of strings). Detects each column via `pragma_table_info` first.
pub(crate) fn ensure_conversation_org_columns(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "conversations", "pinned")? {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(conn, "conversations", "tags")? {
        conn.execute("ALTER TABLE conversations ADD COLUMN tags TEXT", [])?;
    }
    Ok(())
}

fn build_pool() -> Result<Pool<SqliteManager>> {
    let path = db_path()?;
    // Corruption recovery: probe the existing DB before any pooled connection
    // touches it. A failed integrity check quarantines the file so schema
    // setup recreates a fresh DB instead of panicking the whole app.
    if !integrity_ok(&path) {
        quarantine_corrupt_db(&path)?;
    }
    {
        let conn = Connection::open(&path).context("schema setup connection")?;
        setup_schema(&conn)?;
    }
    let manager = SqliteManager { path };
    // Pool sized for concurrent IPC handlers + background workers (scheduler,
    // restart-watcher, agent loop, MCP, RAG). The previous cap of 4 was
    // routinely exhausted under realistic concurrency; 16 keeps short-lived
    // reads from queueing behind a slow write while still bounding open fds.
    Pool::builder()
        .max_size(16)
        .build(manager)
        .map_err(|e| anyhow::anyhow!("pool build failed: {e}"))
}

pub(crate) fn get_db() -> Result<PooledConnection<SqliteManager>> {
    match &*DB {
        Ok(pool) => pool.get().context("db pool exhausted"),
        // Pool build failed at startup — surface the captured reason rather
        // than panicking. Callers map this into IPC errors / UI banners.
        Err(e) => Err(anyhow::anyhow!("db unavailable: {e}")),
    }
}

pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub model: Option<String>,
    pub created_at: i64,
    /// Source conversation if this conv is a fork. None for root conversations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_conv_id: Option<i64>,
    /// Cutoff message id from the parent — messages with id <= this were
    /// deep-copied into this fork at creation time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<i64>,
    /// Raw JSON string of per-conversation model params, or `None` when unset.
    /// Shape: `{ temperature, top_p, max_tokens, system_prompt }` — the
    /// frontend `JSON.parse`s this and applies the values at inference time.
    pub params: Option<String>,
    /// Whether the conversation is pinned. Pinned conversations sort ahead of
    /// the rest in `list_conversations`.
    pub pinned: bool,
    /// Raw JSON-array-of-strings string of user tags, or `None` when unset.
    /// The frontend `JSON.parse`s this back into a string list.
    pub tags: Option<String>,
}

/// Direct-child branch summary, returned by `list_branches`.
#[derive(Serialize, Clone)]
pub struct BranchInfo {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub parent_message_id: Option<i64>,
}

/// Recursive tree node returned by `get_fork_tree`. Depth-capped to bound the
/// response — deeper descendants are silently truncated at the cap.
#[derive(Serialize, Clone)]
pub struct ForkTree {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub parent_conv_id: Option<i64>,
    pub parent_message_id: Option<i64>,
    pub children: Vec<ForkTree>,
}

#[derive(Serialize, Clone)]
pub struct Message {
    pub id: Option<i64>,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: Option<i64>,
    pub model: Option<String>,
    /// JSON-encoded `ChatImage[]` payload. `None` for plain-text messages.
    /// Frontend `JSON.parse`s this back into the `images` field on `Message`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<String>,
}

pub fn create_conversation(title: &str, model: Option<&str>) -> Result<i64> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO conversations (title, model, created_at) VALUES (?1, ?2, ?3)",
        params![title, model, now_unix()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_conversations() -> Result<Vec<Conversation>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, model, created_at, parent_conv_id, parent_message_id, params,
                pinned, tags
         FROM conversations ORDER BY pinned DESC, created_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_conversation)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_conversation(id: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Returns the conversation_id of the deleted message so callers can scope refresh events.
pub fn delete_message(id: i64) -> Result<i64> {
    let conn = get_db()?;
    let conv_id: i64 = conn.query_row(
        "SELECT conversation_id FROM messages WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(conv_id)
}

pub fn rename_conversation(id: i64, title: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

/// Map a `conversations` row (in the canonical 9-column projection) to a
/// `Conversation`. Shared by `list_conversations` and `get_conversation`.
fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        model: r.get(2)?,
        created_at: r.get(3)?,
        parent_conv_id: r.get(4)?,
        parent_message_id: r.get(5)?,
        params: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
        tags: r.get(8)?,
    })
}

/// Fetch a single conversation row by id, including its `params` JSON.
pub fn get_conversation(id: i64) -> Result<Conversation> {
    let conn = get_db()?;
    conn.query_row(
        "SELECT id, title, model, created_at, parent_conv_id, parent_message_id, params,
                pinned, tags
         FROM conversations WHERE id = ?1",
        params![id],
        row_to_conversation,
    )
    .context("conversation not found")
}

/// Validate a `tags` payload: either `None` (clears the column) or a string
/// holding a JSON array whose every element is a string. Anything else is
/// rejected so the column never holds a non-conforming value.
pub fn validate_tags_json(tags: Option<&str>) -> Result<()> {
    let Some(raw) = tags else { return Ok(()) };
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| anyhow::anyhow!("tags is not valid JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("tags must be a JSON array"))?;
    if arr.iter().any(|v| !v.is_string()) {
        return Err(anyhow::anyhow!("tags must be a JSON array of strings"));
    }
    Ok(())
}

/// Set the pinned flag on a conversation. Pinned conversations sort first.
pub fn set_conversation_pinned(id: i64, pinned: bool) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE conversations SET pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )?;
    Ok(())
}

/// Set (or clear, with `None`) a conversation's tags. `tags` must pass
/// `validate_tags_json` — a JSON array of strings, or null.
pub fn set_conversation_tags(id: i64, tags: Option<&str>) -> Result<()> {
    validate_tags_json(tags)?;
    let conn = get_db()?;
    conn.execute(
        "UPDATE conversations SET tags = ?1 WHERE id = ?2",
        params![tags, id],
    )?;
    Ok(())
}

/// A message-body search hit: the conversation the match lives in plus a short
/// snippet of the matching message for display.
#[derive(Serialize, Clone)]
pub struct MessageSearchHit {
    pub conversation_id: i64,
    pub title: String,
    pub snippet: String,
}

/// Maximum length (chars) of a search snippet returned by `search_messages`.
const SEARCH_SNIPPET_CHARS: usize = 160;

/// Escape `%`, `_` and the escape char itself for a SQL `LIKE` pattern, so a
/// user query containing wildcards matches literally. Paired with
/// `ESCAPE '\'` in the query.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Build a single-line snippet centred on the first occurrence of `needle`
/// within `content`, capped at `SEARCH_SNIPPET_CHARS`. Case-insensitive match.
fn make_snippet(content: &str, needle: &str) -> String {
    let collapsed: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= SEARCH_SNIPPET_CHARS {
        return collapsed;
    }
    let lower = collapsed.to_lowercase();
    let hit = lower.find(&needle.to_lowercase()).unwrap_or(0);
    // Convert the byte offset of the hit into a char index.
    let hit_char = collapsed[..hit].chars().count();
    let start = hit_char.saturating_sub(SEARCH_SNIPPET_CHARS / 4);
    let end = (start + SEARCH_SNIPPET_CHARS).min(chars.len());
    let body: String = chars[start..end].iter().collect();
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    format!("{prefix}{body}{suffix}")
}

/// Full-text-ish search across message bodies. Returns at most one hit per
/// conversation (the most recent matching message), newest conversation first.
/// Matching uses SQL `LIKE` with `%`/`_` escaped so the query matches literally.
pub fn search_messages(query: &str) -> Result<Vec<MessageSearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", escape_like(trimmed));
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT m.conversation_id, c.title, m.content
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id IN (
            SELECT MAX(id) FROM messages
            WHERE content LIKE ?1 ESCAPE '\\'
            GROUP BY conversation_id
         )
         ORDER BY m.conversation_id DESC",
    )?;
    let rows = stmt
        .query_map(params![pattern], |r| {
            let conversation_id: i64 = r.get(0)?;
            let title: String = r.get(1)?;
            let content: String = r.get(2)?;
            Ok((conversation_id, title, content))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(conversation_id, title, content)| MessageSearchHit {
            conversation_id,
            title,
            snippet: make_snippet(&content, trimmed),
        })
        .collect())
}

/// Persist per-conversation model params. `params` must be either `None`
/// (clears the column) or a string containing a parseable JSON object —
/// malformed JSON is rejected so the column never holds garbage.
pub fn update_conversation_params(id: i64, params: Option<&str>) -> Result<()> {
    if let Some(raw) = params {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| anyhow::anyhow!("params is not valid JSON: {e}"))?;
        if !value.is_object() {
            return Err(anyhow::anyhow!("params must be a JSON object"));
        }
    }
    let conn = get_db()?;
    conn.execute(
        "UPDATE conversations SET params = ?1 WHERE id = ?2",
        params![params, id],
    )?;
    Ok(())
}

/// Placeholder title assigned to freshly created conversations. The frontend
/// "+ New chat" path inserts a conversation with exactly this title; auto-
/// titling only fires while the title is still empty or this placeholder.
pub const DEFAULT_CONVERSATION_TITLE: &str = "New chat";

/// Soft target length for an auto-derived conversation title.
const AUTOTITLE_MAX_CHARS: usize = 48;

/// Derive a short, single-line conversation title from a message body.
///
/// Whitespace (including newlines) is collapsed to single spaces and the
/// result trimmed. If the trimmed text fits within `AUTOTITLE_MAX_CHARS` it is
/// returned verbatim; otherwise it is truncated on a word boundary where one
/// exists in the kept window and an ellipsis ('…') is appended. Empty or
/// whitespace-only input yields `None` — callers keep the existing title.
pub fn derive_title(content: &str) -> Option<String> {
    let collapsed: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    // Operate on chars to stay UTF-8 safe under multibyte input.
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= AUTOTITLE_MAX_CHARS {
        return Some(collapsed);
    }
    let window: String = chars[..AUTOTITLE_MAX_CHARS].iter().collect();
    // Prefer cutting at the last space so we don't end on a partial word.
    let trimmed = match window.rfind(' ') {
        Some(idx) if idx > 0 => &window[..idx],
        _ => window.trim_end(),
    };
    Some(format!("{}…", trimmed.trim_end()))
}

/// Whether `title` is still the create-time placeholder (or empty), meaning the
/// conversation has never been explicitly named and is eligible for auto-titling.
fn title_is_placeholder(title: &str) -> bool {
    let t = title.trim();
    t.is_empty() || t == DEFAULT_CONVERSATION_TITLE
}

pub fn add_message(
    conv_id: i64,
    role: &str,
    content: &str,
    model: Option<&str>,
    images_json: Option<&str>,
) -> Result<i64> {
    let mut conn = get_db()?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![conv_id, role, content, now_unix(), model, images_json],
    )?;
    let message_id = tx.last_insert_rowid();

    // Auto-title: only on the first user message of a still-unnamed conversation.
    if role == "user" {
        if let Some(new_title) = derive_title(content) {
            let current_title: Option<String> = tx
                .query_row(
                    "SELECT title FROM conversations WHERE id = ?1",
                    params![conv_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(current_title) = current_title {
                if title_is_placeholder(&current_title) {
                    let prior_user_msgs: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM messages
                         WHERE conversation_id = ?1 AND role = 'user' AND id <> ?2",
                        params![conv_id, message_id],
                        |r| r.get(0),
                    )?;
                    if prior_user_msgs == 0 {
                        tx.execute(
                            "UPDATE conversations SET title = ?1 WHERE id = ?2",
                            params![new_title, conv_id],
                        )?;
                    }
                }
            }
        }
    }

    tx.commit()?;
    Ok(message_id)
}

pub fn list_messages(conv_id: i64) -> Result<Vec<Message>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, created_at, model, images FROM messages
         WHERE conversation_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt
        .query_map(params![conv_id], |r| {
            Ok(Message {
                id: Some(r.get(0)?),
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                created_at: Some(r.get(4)?),
                model: r.get(5)?,
                images: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Maximum fork-tree recursion depth. Bounds the response so a pathological
/// chain of forks can't blow the stack or balloon the JSON payload.
const FORK_TREE_MAX_DEPTH: usize = 10;

/// Deep-copy a conversation up to (and including) `at_message_id`.
///
/// 1. Inserts a new `conversations` row with `parent_conv_id = source_id` and
///    `parent_message_id = at_message_id`. Title is the source title + " (fork)".
/// 2. Copies every message from the source with `id <= at_message_id` into the
///    new conversation, **assigning fresh ids** — modifying the fork after
///    creation will never touch the parent's rows.
///
/// All writes run inside a single transaction; if any step fails the whole
/// thing rolls back and no partial fork remains in the DB.
pub fn fork_conversation(source_id: i64, at_message_id: i64) -> Result<i64> {
    let mut conn = get_db()?;
    fork_conversation_in(&mut conn, source_id, at_message_id)
}

/// Connection-scoped fork implementation. Pulled out so tests can drive it on
/// an in-memory DB without standing up the global pool.
pub(crate) fn fork_conversation_in(
    conn: &mut Connection,
    source_id: i64,
    at_message_id: i64,
) -> Result<i64> {
    let tx = conn.transaction()?;

    // Look up the source row. Bail loudly if it doesn't exist — silently
    // creating an orphan fork would just hide caller bugs.
    let (title, model): (String, Option<String>) = tx
        .query_row(
            "SELECT title, model FROM conversations WHERE id = ?1",
            params![source_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .context("source conversation not found")?;

    let fork_title = format!("{title} (fork)");
    tx.execute(
        "INSERT INTO conversations (title, model, created_at, parent_conv_id, parent_message_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![fork_title, model, now_unix(), source_id, at_message_id],
    )?;
    let new_id = tx.last_insert_rowid();

    // Copy messages with id <= cutoff. `INSERT … SELECT` keeps the per-row
    // work in SQLite and assigns new autoincrement ids automatically.
    tx.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
         SELECT ?1, role, content, created_at, model, images
         FROM messages
         WHERE conversation_id = ?2 AND id <= ?3
         ORDER BY id ASC",
        params![new_id, source_id, at_message_id],
    )?;

    tx.commit()?;
    Ok(new_id)
}

/// Direct children of `conv_id` — does not recurse. Use `get_fork_tree` for
/// the full descendant tree.
pub fn list_branches(conv_id: i64) -> Result<Vec<BranchInfo>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, parent_message_id
         FROM conversations
         WHERE parent_conv_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![conv_id], |r| {
            Ok(BranchInfo {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                parent_message_id: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Recursive walk producing a tree of conversation nodes rooted at
/// `root_conv_id`. Depth-capped at `FORK_TREE_MAX_DEPTH` — descendants past
/// the cap are silently dropped (their parent node is still returned with
/// `children = []`).
pub fn get_fork_tree(root_conv_id: i64) -> Result<ForkTree> {
    let conn = get_db()?;
    fork_tree_node(&conn, root_conv_id, 0)
}

fn fork_tree_node(conn: &Connection, id: i64, depth: usize) -> Result<ForkTree> {
    let (title, created_at, parent_conv_id, parent_message_id): (
        String,
        i64,
        Option<i64>,
        Option<i64>,
    ) = conn
        .query_row(
            "SELECT title, created_at, parent_conv_id, parent_message_id
             FROM conversations WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .context("conversation not found")?;

    let children = if depth >= FORK_TREE_MAX_DEPTH {
        // Cap reached — return the node but stop recursing. Truncation is
        // silent; the frontend can show an ellipsis if it tracks depth.
        Vec::new()
    } else {
        let mut stmt = conn.prepare(
            "SELECT id FROM conversations WHERE parent_conv_id = ?1 ORDER BY created_at ASC",
        )?;
        let child_ids: Vec<i64> = stmt
            .query_map(params![id], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut nodes = Vec::with_capacity(child_ids.len());
        for cid in child_ids {
            nodes.push(fork_tree_node(conn, cid, depth + 1)?);
        }
        nodes
    };

    Ok(ForkTree {
        id,
        title,
        created_at,
        parent_conv_id,
        parent_message_id,
        children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a fresh in-memory DB pre-populated with the *pre-images* schema
    /// shape, then run the migration twice. Tests both correctness (column
    /// appears) and idempotence (re-running does not error out on the
    /// "duplicate column name" SQLite raises).
    #[test]
    fn images_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                model TEXT
            );",
        )
        .unwrap();

        ensure_messages_images_column(&conn).expect("first migration");
        ensure_messages_images_column(&conn).expect("second migration must not error");
        ensure_messages_images_column(&conn).expect("third migration must not error");

        // The column must now be present.
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'images'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has, "images column should exist after migration");
    }

    /// Build an in-memory DB with the post-fork-migration schema and seed a
    /// conversation with `n` messages. Returns (conn, conversation_id).
    fn fresh_db_with_conv(n: usize) -> (Connection, i64) {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                model TEXT,
                images TEXT
            );",
        )
        .unwrap();
        // Run the migration twice to confirm idempotence under realistic boot.
        ensure_conversation_fork_columns(&conn).expect("fork migration 1");
        ensure_conversation_fork_columns(&conn).expect("fork migration 2 must not error");
        ensure_conversation_params_column(&conn).expect("params migration 1");
        ensure_conversation_params_column(&conn).expect("params migration 2 must not error");
        ensure_conversation_org_columns(&conn).expect("org migration 1");
        ensure_conversation_org_columns(&conn).expect("org migration 2 must not error");

        conn.execute(
            "INSERT INTO conversations (title, model, created_at) VALUES (?1, ?2, ?3)",
            params!["seed", Some("test-model"), 1000_i64],
        )
        .unwrap();
        let conv_id = conn.last_insert_rowid();
        for i in 0..n {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conv_id,
                    role,
                    format!("msg-{i}"),
                    1000_i64 + i as i64,
                    "m",
                    Option::<String>::None
                ],
            )
            .unwrap();
        }
        // Sanity check that we actually have the parent columns.
        let _: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'parent_conv_id'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        (conn, conv_id)
    }

    fn message_count(conn: &Connection, conv_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
            params![conv_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    }

    #[test]
    fn fork_copies_messages_up_to_cutoff() {
        let (mut conn, src) = fresh_db_with_conv(5);
        // Cutoff at the 3rd message (id = 3 since autoincrement starts at 1
        // and we seeded a single conversation).
        let cutoff = 3;
        let fork_id = fork_conversation_in(&mut conn, src, cutoff).expect("fork");
        assert_ne!(fork_id, src, "fork must have a distinct id");

        // Exactly the first `cutoff` messages should be present.
        assert_eq!(message_count(&conn, fork_id), cutoff);
        assert_eq!(
            message_count(&conn, src),
            5,
            "parent untouched at fork time"
        );

        // Parent link is recorded on the fork row.
        let (parent, parent_msg, title): (Option<i64>, Option<i64>, String) = conn
            .query_row(
                "SELECT parent_conv_id, parent_message_id, title FROM conversations WHERE id = ?1",
                params![fork_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, Some(src));
        assert_eq!(parent_msg, Some(cutoff));
        assert!(title.ends_with(" (fork)"));

        // Messages on the fork must have *new* ids, not the originals — proving
        // we did a deep copy rather than re-pointing.
        let original_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| r.get::<_, i64>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let fork_ids: Vec<i64> = {
            let mut s = conn
                .prepare("SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![fork_id], |r| r.get::<_, i64>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for fid in &fork_ids {
            assert!(
                !original_ids.contains(fid),
                "fork message id {fid} collided with parent — copy was shallow"
            );
        }
    }

    #[test]
    fn parent_unchanged_after_fork_is_mutated() {
        let (mut conn, src) = fresh_db_with_conv(4);
        let fork_id = fork_conversation_in(&mut conn, src, 2).expect("fork");

        // Snapshot parent before mutating the fork.
        let parent_before: Vec<(i64, String)> = {
            let mut s = conn
                .prepare("SELECT id, content FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };

        // Mutate the fork: append a new message AND rewrite an existing one.
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
             VALUES (?1, 'user', 'fork-only', 9999, 'm', NULL)",
            params![fork_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE messages SET content = 'rewritten in fork'
             WHERE conversation_id = ?1 AND role = 'user'",
            params![fork_id],
        )
        .unwrap();
        // Also delete a fork message — must not cascade to parent.
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND content = 'fork-only'",
            params![fork_id],
        )
        .unwrap();

        let parent_after: Vec<(i64, String)> = {
            let mut s = conn
                .prepare("SELECT id, content FROM messages WHERE conversation_id = ?1 ORDER BY id")
                .unwrap();
            s.query_map(params![src], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };

        assert_eq!(
            parent_before, parent_after,
            "parent rows must be identical after fork mutation"
        );
        assert_eq!(message_count(&conn, src), 4, "parent count untouched");
    }

    #[test]
    fn derive_title_collapses_whitespace() {
        let got = derive_title("  hello\n\tthere   world  ").unwrap();
        assert_eq!(got, "hello there world");
    }

    #[test]
    fn derive_title_returns_none_for_empty_or_whitespace() {
        assert!(derive_title("").is_none());
        assert!(derive_title("   \n\t  ").is_none());
    }

    #[test]
    fn derive_title_keeps_short_input_verbatim() {
        let short = "How do I parse JSON in Rust?";
        assert_eq!(derive_title(short).unwrap(), short);
    }

    #[test]
    fn derive_title_truncates_on_word_boundary_with_ellipsis() {
        let long = "Please explain how the Rust borrow checker handles \
                    nested closures and lifetimes";
        let got = derive_title(long).unwrap();
        assert!(got.ends_with('…'), "expected ellipsis, got {got:?}");
        // No trailing partial word: the char before the ellipsis is not mid-word
        // truncation — the kept text matches the start of the collapsed input.
        let body = got.trim_end_matches('…');
        assert!(long.starts_with(body), "kept text must be a prefix");
        assert!(!body.ends_with(' '), "no trailing space before ellipsis");
        // Soft cap honoured (body + ellipsis stays bounded).
        assert!(body.chars().count() <= 48);
    }

    #[test]
    fn derive_title_handles_no_space_overlong_input() {
        let long = "a".repeat(120);
        let got = derive_title(&long).unwrap();
        assert!(got.ends_with('…'));
        assert_eq!(got.trim_end_matches('…').chars().count(), 48);
    }

    #[test]
    fn derive_title_is_utf8_safe() {
        // 60 multibyte chars — truncation must not split a char.
        let long = "数".repeat(60);
        let got = derive_title(&long).unwrap();
        assert!(got.ends_with('…'));
    }

    #[test]
    fn params_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_params_column(&conn).expect("first");
        ensure_conversation_params_column(&conn).expect("second");
        ensure_conversation_params_column(&conn).expect("third");
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'params'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);
    }

    /// `update_conversation_params` only accepts `None` or a parseable JSON
    /// object. Everything else (malformed JSON, non-object JSON) is rejected.
    #[test]
    fn params_json_validation() {
        // The validation logic, exercised directly without the global pool.
        fn validate(p: Option<&str>) -> Result<()> {
            if let Some(raw) = p {
                let value: serde_json::Value = serde_json::from_str(raw)
                    .map_err(|e| anyhow::anyhow!("params is not valid JSON: {e}"))?;
                if !value.is_object() {
                    return Err(anyhow::anyhow!("params must be a JSON object"));
                }
            }
            Ok(())
        }

        // Valid: null.
        assert!(validate(None).is_ok());
        // Valid: a well-formed params object.
        assert!(validate(Some(
            r#"{"temperature":0.7,"top_p":null,"max_tokens":2048,"system_prompt":"hi"}"#
        ))
        .is_ok());
        // Valid: empty object.
        assert!(validate(Some("{}")).is_ok());
        // Invalid: malformed JSON.
        assert!(validate(Some("{not json")).is_err());
        assert!(validate(Some(r#"{"temperature": }"#)).is_err());
        // Invalid: valid JSON but not an object.
        assert!(validate(Some("[1,2,3]")).is_err());
        assert!(validate(Some("42")).is_err());
        assert!(validate(Some("\"a string\"")).is_err());
    }

    /// Feed a deliberately-corrupt SQLite file: the integrity probe must flag
    /// it, quarantine must rename it aside (with siblings), and schema setup
    /// must then produce a usable fresh DB at the original path.
    #[test]
    fn corrupt_db_is_quarantined_and_recreated() {
        let dir =
            std::env::temp_dir().join(format!("froglips-db-corrupt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("db.sqlite");

        // Garbage bytes — not a valid SQLite header.
        std::fs::write(&db, b"this is definitely not a sqlite database file").unwrap();

        // Probe flags it as corrupt.
        assert!(!integrity_ok(&db), "garbage file must fail integrity check");

        // Plausible WAL/SHM siblings that must also be moved aside. Written
        // after the probe — SQLite may clean up sidecar files when it closes
        // a connection it opened during the integrity check.
        std::fs::write(dir.join("db.sqlite-wal"), b"junk-wal").unwrap();
        std::fs::write(dir.join("db.sqlite-shm"), b"junk-shm").unwrap();

        // Quarantine renames the file aside.
        quarantine_corrupt_db(&db).expect("quarantine should succeed");
        assert!(!db.exists(), "corrupt file must be moved off the live path");
        let quarantined: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            quarantined.iter().any(|n| n.contains("db.sqlite.corrupt-")),
            "expected a quarantined db file, got {quarantined:?}"
        );
        assert!(
            quarantined.iter().any(|n| n.ends_with("-wal")),
            "wal sibling should be quarantined too"
        );
        assert!(
            quarantined.iter().any(|n| n.ends_with("-shm")),
            "shm sibling should be quarantined too"
        );

        // A fresh DB built at the original path is healthy and usable.
        {
            let conn = Connection::open(&db).expect("open fresh db");
            setup_schema(&conn).expect("schema setup on fresh db");
            let ok: String = conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap();
            assert_eq!(ok, "ok", "fresh db must pass integrity check");
            conn.execute(
                "INSERT INTO conversations (title, model, created_at) VALUES ('t', NULL, 1)",
                [],
            )
            .expect("fresh db must accept writes");
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A healthy DB must pass the integrity probe untouched.
    #[test]
    fn healthy_db_passes_integrity_check() {
        let dir =
            std::env::temp_dir().join(format!("froglips-db-healthy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("db.sqlite");
        {
            let conn = Connection::open(&db).unwrap();
            setup_schema(&conn).unwrap();
        }
        assert!(integrity_ok(&db), "a real db must pass integrity check");
        // A non-existent path is treated as fine — schema setup will create it.
        assert!(integrity_ok(&dir.join("does-not-exist.sqlite")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The full set of columns the migration ladder must produce on each
    /// table — the canonical "today's schema" assertion target.
    fn assert_final_schema(conn: &Connection) {
        let cols = |table: &str| -> Vec<String> {
            let mut s = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap();
            s.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        for c in [
            "id",
            "title",
            "model",
            "created_at",
            "parent_conv_id",
            "parent_message_id",
            "params",
            "pinned",
            "tags",
        ] {
            assert!(
                cols("conversations").contains(&c.to_string()),
                "conversations.{c}"
            );
        }
        for c in [
            "id",
            "conversation_id",
            "role",
            "content",
            "created_at",
            "model",
            "images",
        ] {
            assert!(cols("messages").contains(&c.to_string()), "messages.{c}");
        }
        for c in ["scope", "project_root"] {
            assert!(cols("memories").contains(&c.to_string()), "memories.{c}");
        }
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    /// A fresh DB run through the ladder lands on the final user_version with
    /// the complete current schema.
    #[test]
    fn migration_ladder_fresh_db_reaches_latest() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(user_version(&conn), 0, "fresh DB starts at version 0");
        run_migrations(&conn).expect("ladder on fresh db");
        assert_eq!(user_version(&conn), latest_version());
        assert_final_schema(&conn);
    }

    /// Running the ladder a second time on an already-migrated DB is a no-op:
    /// no error, version unchanged, schema unchanged.
    #[test]
    fn migration_ladder_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).expect("first run");
        let v1 = user_version(&conn);
        run_migrations(&conn).expect("second run must be a no-op");
        run_migrations(&conn).expect("third run must be a no-op");
        assert_eq!(user_version(&conn), v1);
        assert_final_schema(&conn);
    }

    /// An old-shape DB — base tables only, user_version 0, pre-images/params —
    /// upgrades cleanly through the ladder with no data loss.
    #[test]
    fn migration_ladder_upgrades_old_db() {
        let conn = Connection::open_in_memory().unwrap();
        // Pre-ladder shape: v1 base tables, never version-stamped.
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                conversation_id INTEGER,
                source_msg_id INTEGER,
                tags TEXT NOT NULL DEFAULT '',
                embedding BLOB,
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );",
        )
        .unwrap();
        // Seed real rows so we can prove they survive the upgrade.
        conn.execute(
            "INSERT INTO conversations (title, model, created_at) VALUES ('old chat', 'm', 100)",
            [],
        )
        .unwrap();
        let cid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at)
             VALUES (?1, 'user', 'hello from the past', 101)",
            params![cid],
        )
        .unwrap();
        assert_eq!(user_version(&conn), 0);

        run_migrations(&conn).expect("upgrade old db");

        assert_eq!(user_version(&conn), latest_version());
        assert_final_schema(&conn);
        // Data preserved.
        let (title, content): (String, String) = conn
            .query_row(
                "SELECT c.title, m.content FROM conversations c
                 JOIN messages m ON m.conversation_id = c.id WHERE c.id = ?1",
                params![cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "old chat");
        assert_eq!(content, "hello from the past");
        // New columns have their defaults on the migrated row.
        let pinned: i64 = conn
            .query_row(
                "SELECT pinned FROM conversations WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pinned, 0);
    }

    #[test]
    fn org_columns_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_org_columns(&conn).expect("first");
        ensure_conversation_org_columns(&conn).expect("second");
        ensure_conversation_org_columns(&conn).expect("third");
        assert!(column_exists(&conn, "conversations", "pinned").unwrap());
        assert!(column_exists(&conn, "conversations", "tags").unwrap());
    }

    /// `validate_tags_json` accepts only `None` or a JSON array of strings.
    #[test]
    fn tags_json_validation() {
        assert!(validate_tags_json(None).is_ok());
        assert!(validate_tags_json(Some("[]")).is_ok());
        assert!(validate_tags_json(Some(r#"["work","urgent"]"#)).is_ok());
        // Malformed JSON.
        assert!(validate_tags_json(Some("[not json")).is_err());
        // Valid JSON but not an array.
        assert!(validate_tags_json(Some(r#"{"a":1}"#)).is_err());
        assert!(validate_tags_json(Some("42")).is_err());
        // Array with non-string elements.
        assert!(validate_tags_json(Some("[1,2,3]")).is_err());
        assert!(validate_tags_json(Some(r#"["ok",5]"#)).is_err());
        assert!(validate_tags_json(Some(r#"["ok",null]"#)).is_err());
    }

    #[test]
    fn escape_like_escapes_wildcards() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("c:\\path"), "c:\\\\path");
        assert_eq!(escape_like("plain"), "plain");
    }

    #[test]
    fn snippet_is_capped_and_centred() {
        let short = "a short message";
        assert_eq!(make_snippet(short, "short"), short);
        let long = format!("{} needle {}", "x ".repeat(200), "y ".repeat(200));
        let snip = make_snippet(&long, "needle");
        assert!(snip.chars().count() <= SEARCH_SNIPPET_CHARS + 2);
        assert!(snip.to_lowercase().contains("needle"));
    }

    #[test]
    fn fork_columns_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                model TEXT,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        ensure_conversation_fork_columns(&conn).expect("first");
        ensure_conversation_fork_columns(&conn).expect("second");
        ensure_conversation_fork_columns(&conn).expect("third");
        let has: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'parent_conv_id'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(has);
    }
}
