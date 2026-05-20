use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use r2d2::{ManageConnection, Pool, PooledConnection};
use rusqlite::{params, Connection};
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
        conn.execute_batch("")
    }

    fn has_broken(&self, _: &mut Connection) -> bool {
        false
    }
}

static DB: Lazy<Pool<SqliteManager>> = Lazy::new(|| build_pool().expect("build db pool"));

fn db_path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
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
        "SELECT id, title, model, created_at FROM conversations ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                model: r.get(2)?,
                created_at: r.get(3)?,
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

pub fn delete_message(id: i64) -> Result<()> {
    let conn = get_db()?;
    conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_conversation(id: i64, title: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

pub fn add_message(
    conv_id: i64,
    role: &str,
    content: &str,
    model: Option<&str>,
    images_json: Option<&str>,
) -> Result<i64> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![conv_id, role, content, now_unix(), model, images_json],
    )?;
    Ok(conn.last_insert_rowid())
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
}
