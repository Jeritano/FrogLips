//! Database backup, JSON export, and JSON import.
//!
//! * `backup_database` — a consistent single-file copy of the live SQLite DB
//!   via SQLite's online backup API. Safe to run while the app is in use.
//! * `export_data` — conversations + messages + memory entries serialized to a
//!   versioned, human-readable JSON document.
//! * `import_data` — additively merges an exported document back into the live
//!   DB inside a transaction, assigning fresh ids and remapping references.

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::history::{db_path, get_db, now_unix};

/// JSON export schema version. Bump when the document shape changes in a way
/// that older importers can't read; `import_data` rejects unknown versions.
pub const SCHEMA_VERSION: u32 = 1;

/* ── Export document shape ── */

#[derive(Serialize, Deserialize)]
pub struct ExportDoc {
    pub schema_version: u32,
    /// App version that produced the file — informational only.
    #[serde(default)]
    pub app_version: String,
    /// Unix seconds the export was taken.
    #[serde(default)]
    pub exported_at: i64,
    pub conversations: Vec<ExportConversation>,
    pub memories: Vec<ExportMemory>,
}

#[derive(Serialize, Deserialize)]
pub struct ExportConversation {
    /// Original id in the source DB. Used only to remap message/memory refs;
    /// the importer assigns a fresh id.
    pub id: i64,
    pub title: String,
    pub model: Option<String>,
    pub created_at: i64,
    pub params: Option<String>,
    pub messages: Vec<ExportMessage>,
}

#[derive(Serialize, Deserialize)]
pub struct ExportMessage {
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub model: Option<String>,
    pub images: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ExportMemory {
    pub content: String,
    /// Source conversation id (in the source DB), remapped on import. `None`
    /// for global/project memories not tied to a conversation.
    pub conversation_id: Option<i64>,
    pub tags: String,
    pub status: String,
    pub created_at: i64,
    pub scope: String,
    pub project_root: Option<String>,
}

/* ── Backup ── */

/// Produce a consistent single-file backup of the live DB at `dest`. Uses
/// SQLite's online backup API, which is safe against concurrent writers.
pub fn backup_database(dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
    }
    let src_path = db_path()?;
    if dest == src_path {
        bail!("backup destination must differ from the live database");
    }
    let src = Connection::open(&src_path).context("open source db for backup")?;
    let mut dst = Connection::open(dest)
        .with_context(|| format!("open backup destination {}", dest.display()))?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst)
        .context("initialize online backup")?;
    backup
        .run_to_completion(64, std::time::Duration::from_millis(50), None)
        .context("run online backup")?;
    Ok(())
}

/* ── Export ── */

/// Bare conversation row, before its messages are attached.
struct ConvRow {
    id: i64,
    title: String,
    model: Option<String>,
    created_at: i64,
    params: Option<String>,
}

/// Collect the full export document from a connection. Factored out so tests
/// can run it against an in-memory DB.
pub fn collect_export(conn: &Connection) -> Result<ExportDoc> {
    let mut conversations = Vec::new();
    {
        let mut conv_stmt = conn
            .prepare("SELECT id, title, model, created_at, params FROM conversations ORDER BY id")?;
        let convs: Vec<ConvRow> = conv_stmt
            .query_map([], |r| {
                Ok(ConvRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    model: r.get(2)?,
                    created_at: r.get(3)?,
                    params: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        for c in convs {
            let mut msg_stmt = conn.prepare(
                "SELECT role, content, created_at, model, images
                 FROM messages WHERE conversation_id = ?1 ORDER BY id",
            )?;
            let messages: Vec<ExportMessage> = msg_stmt
                .query_map(params![c.id], |r| {
                    Ok(ExportMessage {
                        role: r.get(0)?,
                        content: r.get(1)?,
                        created_at: r.get(2)?,
                        model: r.get(3)?,
                        images: r.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            conversations.push(ExportConversation {
                id: c.id,
                title: c.title,
                model: c.model,
                created_at: c.created_at,
                params: c.params,
                messages,
            });
        }
    }
    let mut mem_stmt = conn.prepare(
        "SELECT content, conversation_id, tags, status, created_at, scope, project_root
         FROM memories ORDER BY id",
    )?;
    let memories: Vec<ExportMemory> = mem_stmt
        .query_map([], |r| {
            Ok(ExportMemory {
                content: r.get(0)?,
                conversation_id: r.get(1)?,
                tags: r.get(2)?,
                status: r.get(3)?,
                created_at: r.get(4)?,
                scope: r.get(5)?,
                project_root: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(mem_stmt);
    Ok(ExportDoc {
        schema_version: SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: now_unix(),
        conversations,
        memories,
    })
}

/// Export the live DB to a pretty-printed JSON document at `dest`.
pub fn export_data(dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
    }
    let conn = get_db()?;
    let doc = collect_export(&conn)?;
    let json = serde_json::to_string_pretty(&doc).context("serialize export document")?;
    std::fs::write(dest, json)
        .with_context(|| format!("write export to {}", dest.display()))?;
    Ok(())
}

/* ── Import ── */

/// Summary returned to the caller after a successful import.
#[derive(Serialize)]
pub struct ImportSummary {
    pub conversations: usize,
    pub messages: usize,
    pub memories: usize,
}

/// Parse and validate an export document from JSON text. Rejects unknown or
/// incompatible `schema_version` values with a clear error.
pub fn parse_export(text: &str) -> Result<ExportDoc> {
    let doc: ExportDoc = serde_json::from_str(text)
        .map_err(|e| anyhow!("malformed export file: {e}"))?;
    if doc.schema_version != SCHEMA_VERSION {
        bail!(
            "incompatible export file: schema_version {} (this build expects {})",
            doc.schema_version,
            SCHEMA_VERSION
        );
    }
    Ok(doc)
}

/// Additively import `doc` into `conn` inside a single transaction. Existing
/// rows are never touched; every imported row gets a fresh id and message /
/// memory references are remapped onto the new conversation ids. On any error
/// the transaction rolls back, leaving the DB unchanged.
pub fn apply_import(conn: &mut Connection, doc: &ExportDoc) -> Result<ImportSummary> {
    let tx = conn.transaction().context("begin import transaction")?;
    let mut n_conv = 0usize;
    let mut n_msg = 0usize;
    let mut n_mem = 0usize;
    // Maps source conversation id -> freshly assigned id in this DB.
    let mut id_map: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();

    for conv in &doc.conversations {
        tx.execute(
            "INSERT INTO conversations (title, model, created_at, params)
             VALUES (?1, ?2, ?3, ?4)",
            params![conv.title, conv.model, conv.created_at, conv.params],
        )?;
        let new_id = tx.last_insert_rowid();
        id_map.insert(conv.id, new_id);
        n_conv += 1;
        for m in &conv.messages {
            if !matches!(m.role.as_str(), "system" | "user" | "assistant") {
                bail!("import rejected: invalid message role {:?}", m.role);
            }
            tx.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![new_id, m.role, m.content, m.created_at, m.model, m.images],
            )?;
            n_msg += 1;
        }
    }

    for mem in &doc.memories {
        // Remap the source conversation id; drop the link if the referenced
        // conversation isn't part of this import (can't fabricate a target).
        let conv_id = match mem.conversation_id {
            Some(src) => id_map.get(&src).copied(),
            None => None,
        };
        tx.execute(
            "INSERT INTO memories
                (content, conversation_id, source_msg_id, tags, embedding, status,
                 created_at, scope, project_root)
             VALUES (?1, ?2, NULL, ?3, NULL, ?4, ?5, ?6, ?7)",
            params![
                mem.content,
                conv_id,
                mem.tags,
                mem.status,
                mem.created_at,
                mem.scope,
                mem.project_root,
            ],
        )?;
        n_mem += 1;
    }

    tx.commit().context("commit import transaction")?;
    Ok(ImportSummary {
        conversations: n_conv,
        messages: n_msg,
        memories: n_mem,
    })
}

/// Read, validate, and import a JSON export file at `src` into the live DB.
pub fn import_data(src: &Path) -> Result<ImportSummary> {
    let text = std::fs::read_to_string(src)
        .with_context(|| format!("read export file {}", src.display()))?;
    let doc = parse_export(&text)?;
    let mut conn = get_db()?;
    apply_import(&mut conn, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an in-memory DB with the minimal schema the export/import code
    /// touches, seeded with `convs` conversations each holding 2 messages and
    /// one conversation-scoped memory.
    fn seed_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL,
                params TEXT);
             CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, created_at INTEGER NOT NULL,
                model TEXT, images TEXT);
             CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL, conversation_id INTEGER,
                source_msg_id INTEGER, tags TEXT NOT NULL DEFAULT '',
                embedding BLOB, status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL, last_used_at INTEGER,
                scope TEXT NOT NULL DEFAULT 'global', project_root TEXT);",
        )
        .unwrap();
        conn
    }

    fn empty_db() -> Connection {
        seed_db()
    }

    #[test]
    fn export_import_round_trip() {
        // Source DB: 2 conversations, 2 messages each, 1 conv-scoped memory.
        let src = seed_db();
        for c in 0..2 {
            src.execute(
                "INSERT INTO conversations (title, model, created_at, params)
                 VALUES (?1, ?2, ?3, ?4)",
                params![format!("conv{c}"), "m", 100 + c, None::<String>],
            )
            .unwrap();
            let cid = src.last_insert_rowid();
            for r in ["user", "assistant"] {
                src.execute(
                    "INSERT INTO messages (conversation_id, role, content, created_at, model, images)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![cid, r, format!("{r}-text-{c}"), 200, "m", None::<String>],
                )
                .unwrap();
            }
            src.execute(
                "INSERT INTO memories (content, conversation_id, tags, status, created_at, scope, project_root)
                 VALUES (?1, ?2, '', 'active', 300, 'conversation', NULL)",
                params![format!("mem{c}"), cid],
            )
            .unwrap();
        }

        let doc = collect_export(&src).unwrap();
        assert_eq!(doc.conversations.len(), 2);
        assert_eq!(doc.memories.len(), 2);

        // Import into a fresh, empty DB.
        let mut dst = empty_db();
        let summary = apply_import(&mut dst, &doc).unwrap();
        assert_eq!(summary.conversations, 2);
        assert_eq!(summary.messages, 4);
        assert_eq!(summary.memories, 2);

        // Re-export the destination and assert the data matches.
        let round = collect_export(&dst).unwrap();
        assert_eq!(round.conversations.len(), 2);
        for (orig, got) in doc.conversations.iter().zip(round.conversations.iter()) {
            assert_eq!(orig.title, got.title);
            assert_eq!(orig.messages.len(), got.messages.len());
            for (om, gm) in orig.messages.iter().zip(got.messages.iter()) {
                assert_eq!(om.role, gm.role);
                assert_eq!(om.content, gm.content);
            }
        }

        // Memory conversation refs must be remapped to the NEW conv ids, not
        // the source ids. The destination started empty, so new ids are 1,2.
        let mem_conv_ids: Vec<Option<i64>> =
            round.memories.iter().map(|m| m.conversation_id).collect();
        assert_eq!(mem_conv_ids, vec![Some(1), Some(2)]);
    }

    #[test]
    fn import_is_additive() {
        // Destination already has one conversation; import must not wipe it.
        let mut dst = seed_db();
        dst.execute(
            "INSERT INTO conversations (title, model, created_at, params)
             VALUES ('existing', NULL, 1, NULL)",
            [],
        )
        .unwrap();

        let src = seed_db();
        src.execute(
            "INSERT INTO conversations (title, model, created_at, params)
             VALUES ('imported', NULL, 2, NULL)",
            [],
        )
        .unwrap();
        let doc = collect_export(&src).unwrap();
        apply_import(&mut dst, &doc).unwrap();

        let count: i64 = dst
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "import must add, not replace");
    }

    #[test]
    fn import_rejects_bad_schema_version() {
        let bad = format!(
            r#"{{"schema_version":{},"app_version":"x","exported_at":0,
                 "conversations":[],"memories":[]}}"#,
            SCHEMA_VERSION + 99
        );
        let err = match parse_export(&bad) {
            Ok(_) => panic!("expected rejection of bad schema_version"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("incompatible"), "got: {err}");
    }

    #[test]
    fn import_rejects_malformed_json() {
        let err = match parse_export("{not json") {
            Ok(_) => panic!("expected rejection of malformed json"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("malformed"), "got: {err}");
    }

    #[test]
    fn import_rolls_back_on_bad_role() {
        // A document with an invalid message role must abort the whole import
        // transaction, leaving the destination unchanged.
        let mut dst = seed_db();
        let doc = ExportDoc {
            schema_version: SCHEMA_VERSION,
            app_version: "x".into(),
            exported_at: 0,
            conversations: vec![ExportConversation {
                id: 1,
                title: "c".into(),
                model: None,
                created_at: 1,
                params: None,
                messages: vec![ExportMessage {
                    role: "bogus".into(),
                    content: "x".into(),
                    created_at: 1,
                    model: None,
                    images: None,
                }],
            }],
            memories: vec![],
        };
        assert!(apply_import(&mut dst, &doc).is_err());
        let count: i64 = dst
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "failed import must roll back");
    }
}
