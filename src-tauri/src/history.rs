use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use r2d2::{ManageConnection, Pool, PooledConnection};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;

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

static DB: Lazy<Pool<SqliteManager>> = Lazy::new(|| build_pool().expect("build db pool"));

fn db_path() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let base = home.join(".local-llm-app");
    std::fs::create_dir_all(&base).context("failed to create ~/.local-llm-app")?;
    Ok(base.join("db.sqlite"))
}

fn setup_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS conversations (
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
    let has_model: bool = match conn.query_row(
        "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'model'",
        [],
        |_| Ok(true),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => false,
        Err(e) => return Err(anyhow::anyhow!("schema check failed: {e}")),
    };
    if !has_model {
        conn.execute("ALTER TABLE messages ADD COLUMN model TEXT", [])?;
    }
    // ── Vision attachments migration (idempotent) ────────────────────────
    // Stores a JSON-encoded `ChatImage[]` for messages that carry image
    // attachments. NULL for plain-text turns. Adding here so older databases
    // upgrade in place on first open after this build ships.
    ensure_messages_images_column(conn)?;
    // ── Memory scopes migration (idempotent) ─────────────────────────────
    // Adds: scope ('global'|'project'|'conversation'), project_root.
    // Existing 'conversation_id INTEGER' column is reused for scope='conversation'
    // filtering — it already points at the originating conversation when set.
    ensure_memory_scope_columns(conn)?;
    // ── Conversation branching migration (idempotent) ────────────────────
    // Adds: parent_conv_id, parent_message_id — refs the source conversation
    // and the cutoff message id used to seed the fork (deep-copy boundary).
    ensure_conversation_fork_columns(conn)?;

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

fn build_pool() -> Result<Pool<SqliteManager>> {
    let path = db_path()?;
    {
        let conn = Connection::open(&path).context("schema setup connection")?;
        setup_schema(&conn)?;
    }
    let manager = SqliteManager { path };
    Pool::builder()
        .max_size(4)
        .build(manager)
        .map_err(|e| anyhow::anyhow!("pool build failed: {e}"))
}

pub(crate) fn get_db() -> Result<PooledConnection<SqliteManager>> {
    DB.get().context("db pool exhausted")
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
        "SELECT id, title, model, created_at, parent_conv_id, parent_message_id
         FROM conversations ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                model: r.get(2)?,
                created_at: r.get(3)?,
                parent_conv_id: r.get(4)?,
                parent_message_id: r.get(5)?,
            })
        })?
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
