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
    // Install audit table (idempotent — CREATE TABLE IF NOT EXISTS).
    crate::agent_audit::ensure_schema(conn)?;
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

pub fn add_message(conv_id: i64, role: &str, content: &str, model: Option<&str>) -> Result<i64> {
    let conn = get_db()?;
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, model)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conv_id, role, content, now_unix(), model],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_messages(conv_id: i64) -> Result<Vec<Message>> {
    let conn = get_db()?;
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, created_at, model FROM messages
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
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
