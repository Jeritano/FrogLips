//! Claude Skills library — a global catalog of Anthropic-format "Claude Skill"
//! folders the user has imported. Each row stores the parsed `SKILL.md`
//! frontmatter (`name`, `description`, optional `allowed-tools`) plus the
//! full markdown body, the absolute path to the source folder, and two
//! per-skill toggles:
//!
//!   * `enabled` — when true, the skill appears in the agent's list-skills
//!     tool output (stub: name + description only). Defaults to true.
//!   * `pinned`  — when true, the full `body_md` is prepended to the system
//!     prompt at chat start. Defaults to false.
//!
//! Schema (created by the v15 migration; see `ensure_claude_skills_tables`):
//!
//! ```sql
//! CREATE TABLE claude_skills (
//!     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
//!     name               TEXT NOT NULL UNIQUE,
//!     description        TEXT NOT NULL,
//!     body_md            TEXT NOT NULL,
//!     allowed_tools_json TEXT,
//!     source_path        TEXT NOT NULL,
//!     imported_at        INTEGER NOT NULL,
//!     enabled            INTEGER NOT NULL DEFAULT 1,
//!     pinned             INTEGER NOT NULL DEFAULT 0
//! );
//! ```
//!
//! Validation lives at import time so the row never holds garbage:
//!   * frontmatter must parse as YAML between two `---` fences,
//!   * `name`: 1..=64 chars, `[A-Za-z0-9_-]+`,
//!   * `description`: 1..=512 chars,
//!   * `body_md`: ≤256 KiB,
//!   * `allowed-tools` (if present) is a JSON-encoded string array.
//!
//! Re-importing the same folder with `overwrite=true` updates the row in
//! place but preserves the user's `enabled` and `pinned` toggles — overwrite
//! is "the SKILL.md on disk changed", not "reset my prefs".

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::history::{get_db, now_unix};

/// Hard cap on `name` length (chars; ASCII so chars == bytes).
pub const MAX_NAME_LEN: usize = 64;
/// Hard cap on `description` length (chars).
pub const MAX_DESCRIPTION_LEN: usize = 512;
/// Hard cap on `body_md` size (bytes). 256 KiB — generous for prose-heavy
/// skills, bounded so a malformed import can't blow the SQLite row budget or
/// later balloon the system prompt when the skill is pinned.
pub const MAX_BODY_BYTES: usize = 256 * 1024;

static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSkillRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub body_md: String,
    pub allowed_tools_json: Option<String>,
    pub source_path: String,
    pub imported_at: i64,
    pub enabled: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSkillSummary {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub source_path: String,
    pub enabled: bool,
    pub pinned: bool,
}

/// Structured error carried inside `anyhow::Error`. The IPC layer downcasts
/// to recover `kind`; the frontend / agent loop branches on the kind tag and
/// shows `message` verbatim to the user.
#[derive(Debug)]
pub struct SkillError {
    pub kind: &'static str,
    pub message: String,
}

impl std::fmt::Display for SkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for SkillError {}

fn err(kind: &'static str, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(SkillError {
        kind,
        message: message.into(),
    })
}

/// Idempotently create the `claude_skills` table and its indexes. Called from
/// the v15 migration rung; safe to re-run against a schema that already has
/// them.
pub(crate) fn ensure_claude_skills_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_skills (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            name               TEXT NOT NULL UNIQUE,
            description        TEXT NOT NULL,
            body_md            TEXT NOT NULL,
            allowed_tools_json TEXT,
            source_path        TEXT NOT NULL,
            imported_at        INTEGER NOT NULL,
            enabled            INTEGER NOT NULL DEFAULT 1,
            pinned             INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_claude_skills_enabled
            ON claude_skills(enabled);
         CREATE INDEX IF NOT EXISTS idx_claude_skills_pinned
            ON claude_skills(pinned);",
    )?;
    Ok(())
}

/// Parsed `SKILL.md` payload: the YAML frontmatter (name, description,
/// optional allowed-tools) and the markdown body that follows the closing
/// fence.
#[derive(Debug, Clone)]
struct ParsedSkill {
    name: String,
    description: String,
    allowed_tools: Option<Vec<String>>,
    body_md: String,
}

/// State machine for the frontmatter walk. Easier to reason about than two
/// nested for-loops with `break` flags, and lets a single pass over
/// `split_inclusive('\n')` do both the fence detection and the body offset.
enum FrontmatterState {
    /// Haven't seen the opening `---` yet; skipping leading blanks.
    SeekOpen,
    /// Inside the YAML block; collecting lines until the closing `---`.
    InBlock,
    /// Closing fence consumed; body starts at the next byte.
    Done,
}

/// Parse a `SKILL.md` source: a YAML frontmatter block delimited by two
/// `---` fences on their own lines, followed by the markdown body.
///
/// Returns `SkillError { kind: "bad_skill_md" }` on any structural problem;
/// missing required keys are wrapped as the same kind so the IPC layer can
/// report a single error class to the UI.
fn parse_skill_md(source: &str) -> Result<ParsedSkill> {
    // Two-phase walk: (1) find the opening `---` fence (allowing leading
    // blank lines), (2) collect everything up to the next `---` as the YAML
    // frontmatter; the remainder is the body.
    //
    // We track byte offsets by hand because `str::lines()` strips the
    // trailing newline — we need to know where the fence ENDS in the source
    // to slice out the body. `split_inclusive('\n')` keeps each line's
    // terminator, so summing `line.len()` gives the exact byte offset.
    let mut frontmatter = String::new();
    let mut state = FrontmatterState::SeekOpen;
    let mut body_start: usize = 0;
    let mut cursor: usize = 0;

    for raw in source.split_inclusive('\n') {
        let trimmed = raw.trim_end_matches('\n').trim_end_matches('\r');
        cursor += raw.len();
        match state {
            FrontmatterState::SeekOpen => {
                if trimmed.trim().is_empty() {
                    continue;
                }
                if trimmed == "---" {
                    state = FrontmatterState::InBlock;
                    continue;
                }
                return Err(err(
                    "bad_skill_md",
                    "first non-empty line of SKILL.md must be '---' (YAML frontmatter fence)",
                ));
            }
            FrontmatterState::InBlock => {
                if trimmed == "---" {
                    state = FrontmatterState::Done;
                    body_start = cursor;
                    break;
                }
                frontmatter.push_str(trimmed);
                frontmatter.push('\n');
            }
            FrontmatterState::Done => break,
        }
    }

    match state {
        FrontmatterState::SeekOpen => {
            return Err(err(
                "bad_skill_md",
                "SKILL.md is empty or contains no frontmatter",
            ));
        }
        FrontmatterState::InBlock => {
            return Err(err(
                "bad_skill_md",
                "YAML frontmatter is missing a closing '---' fence",
            ));
        }
        FrontmatterState::Done => {}
    }

    // Body = everything after the closing fence's newline. Strip a single
    // leading blank line so the body starts at the first content character
    // — preserves intentional blank lines beyond the first.
    let body_md = if body_start >= source.len() {
        String::new()
    } else {
        let rest = &source[body_start..];
        // Eat at most one leading "\n" or "\r\n" so a typical
        // "---\n\n# Heading\n" body starts at "# Heading".
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        rest.to_string()
    };

    #[derive(serde::Deserialize)]
    struct RawFrontmatter {
        name: Option<String>,
        description: Option<String>,
        #[serde(rename = "allowed-tools")]
        allowed_tools: Option<Vec<String>>,
    }

    let raw: RawFrontmatter = serde_yaml::from_str(&frontmatter)
        .map_err(|e| err("bad_skill_md", format!("YAML parse error: {e}")))?;

    let name = raw
        .name
        .ok_or_else(|| err("bad_skill_md", "missing required frontmatter key 'name'"))?;
    let description = raw.description.ok_or_else(|| {
        err(
            "bad_skill_md",
            "missing required frontmatter key 'description'",
        )
    })?;

    Ok(ParsedSkill {
        name,
        description,
        allowed_tools: raw.allowed_tools,
        body_md,
    })
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(err("bad_name", "name must not be empty"));
    }
    if name.len() > MAX_NAME_LEN {
        return Err(err(
            "bad_name",
            format!("name exceeds {MAX_NAME_LEN} chars"),
        ));
    }
    if !NAME_RE.is_match(name) {
        return Err(err(
            "bad_name",
            "name must match [A-Za-z0-9_-]+ (no spaces, slashes, or punctuation)",
        ));
    }
    Ok(())
}

fn validate_description(description: &str) -> Result<()> {
    if description.is_empty() {
        return Err(err("bad_description", "description must not be empty"));
    }
    if description.len() > MAX_DESCRIPTION_LEN {
        return Err(err(
            "bad_description",
            format!("description exceeds {MAX_DESCRIPTION_LEN} chars"),
        ));
    }
    Ok(())
}

fn validate_body(body: &str) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(err(
            "body_too_large",
            format!("body_md is {} bytes (max {MAX_BODY_BYTES})", body.len()),
        ));
    }
    Ok(())
}

/// Import a Claude Skill from a folder on disk.
///
/// Steps:
///   1. canonicalize the folder path (rejects non-existent paths),
///   2. read `<folder>/SKILL.md`,
///   3. parse + validate the frontmatter and body,
///   4. INSERT a new row, or UPDATE in place if `overwrite=true` and a row
///      with the same `name` already exists.
///
/// On update, `enabled` and `pinned` are preserved — overwrite means "the
/// SKILL.md changed on disk", not "reset my preferences".
///
/// Errors:
///   * `bad_skill_md` — frontmatter or body parsing failed.
///   * `bad_name` / `bad_description` / `body_too_large` — validation.
///   * `name_collision` — a row already exists and `overwrite=false`.
///   * Any I/O error from the filesystem (folder not found, SKILL.md not
///     readable, etc.) propagates as a plain `anyhow::Error`.
pub fn import_from_folder(folder: &Path, overwrite: bool) -> Result<ClaudeSkillRow> {
    if !folder.exists() {
        anyhow::bail!("folder does not exist: {}", folder.display());
    }
    if !folder.is_dir() {
        anyhow::bail!("not a directory: {}", folder.display());
    }
    let canon = fs::canonicalize(folder)
        .with_context(|| format!("failed to canonicalize {}", folder.display()))?;
    let skill_md_path = canon.join("SKILL.md");
    if !skill_md_path.exists() {
        anyhow::bail!("SKILL.md not found in {}", canon.display());
    }
    let source = fs::read_to_string(&skill_md_path)
        .with_context(|| format!("failed to read {}", skill_md_path.display()))?;

    let parsed = parse_skill_md(&source)?;
    validate_name(&parsed.name)?;
    validate_description(&parsed.description)?;
    validate_body(&parsed.body_md)?;

    let allowed_tools_json = match &parsed.allowed_tools {
        Some(tools) => Some(
            serde_json::to_string(tools).context("failed to serialize allowed-tools to JSON")?,
        ),
        None => None,
    };

    let source_path = canon.to_string_lossy().to_string();
    let now = now_unix();

    let mut conn = get_db()?;
    let tx = conn.transaction()?;
    let existing: Option<(i64, bool, bool)> = tx
        .query_row(
            "SELECT id, enabled, pinned FROM claude_skills WHERE name = ?1",
            params![parsed.name],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)? != 0,
                    r.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .ok();

    let (id, enabled, pinned) = match existing {
        None => {
            tx.execute(
                "INSERT INTO claude_skills
                    (name, description, body_md, allowed_tools_json,
                     source_path, imported_at, enabled, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0)",
                params![
                    parsed.name,
                    parsed.description,
                    parsed.body_md,
                    allowed_tools_json,
                    source_path,
                    now,
                ],
            )?;
            (tx.last_insert_rowid(), true, false)
        }
        Some((existing_id, existing_enabled, existing_pinned)) => {
            if !overwrite {
                drop(tx);
                return Err(err(
                    "name_collision",
                    format!("claude skill '{}' already exists", parsed.name),
                ));
            }
            // Update body / metadata / source_path in place; preserve the
            // user's enabled+pinned toggles.
            tx.execute(
                "UPDATE claude_skills
                 SET description = ?1,
                     body_md = ?2,
                     allowed_tools_json = ?3,
                     source_path = ?4,
                     imported_at = ?5
                 WHERE id = ?6",
                params![
                    parsed.description,
                    parsed.body_md,
                    allowed_tools_json,
                    source_path,
                    now,
                    existing_id,
                ],
            )?;
            (existing_id, existing_enabled, existing_pinned)
        }
    };

    tx.commit()?;

    Ok(ClaudeSkillRow {
        id,
        name: parsed.name,
        description: parsed.description,
        body_md: parsed.body_md,
        allowed_tools_json,
        source_path,
        imported_at: now,
        enabled,
        pinned,
    })
}

/// List skills as summaries (no `body_md`). Ordered by `name ASC` for stable
/// catalog output. When `enabled_only=true`, only rows with `enabled=1` are
/// returned — used by the agent loop's stub catalog.
pub fn list(enabled_only: bool) -> Result<Vec<ClaudeSkillSummary>> {
    let conn = get_db()?;
    let sql = if enabled_only {
        "SELECT id, name, description, source_path, enabled, pinned
         FROM claude_skills WHERE enabled = 1 ORDER BY name ASC"
    } else {
        "SELECT id, name, description, source_path, enabled, pinned
         FROM claude_skills ORDER BY name ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ClaudeSkillSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                source_path: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                pinned: r.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Fetch a single skill by name. `Ok(None)` if not present — distinct from an
/// error.
pub fn get(name: &str) -> Result<Option<ClaudeSkillRow>> {
    let conn = get_db()?;
    let row = conn
        .query_row(
            "SELECT id, name, description, body_md, allowed_tools_json,
                    source_path, imported_at, enabled, pinned
             FROM claude_skills WHERE name = ?1",
            params![name],
            |r| {
                Ok(ClaudeSkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    body_md: r.get(3)?,
                    allowed_tools_json: r.get(4)?,
                    source_path: r.get(5)?,
                    imported_at: r.get(6)?,
                    enabled: r.get::<_, i64>(7)? != 0,
                    pinned: r.get::<_, i64>(8)? != 0,
                })
            },
        )
        .ok();
    Ok(row)
}

/// Set the `enabled` toggle on a skill. Affects 0 rows if the name doesn't
/// exist — still returns Ok (idempotent semantics; the caller typically
/// reads the latest state right after).
pub fn set_enabled(name: &str, enabled: bool) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE claude_skills SET enabled = ?1 WHERE name = ?2",
        params![if enabled { 1 } else { 0 }, name],
    )?;
    Ok(())
}

/// Set the `pinned` toggle on a skill. Same idempotent semantics as
/// `set_enabled`.
pub fn set_pinned(name: &str, pinned: bool) -> Result<()> {
    let conn = get_db()?;
    conn.execute(
        "UPDATE claude_skills SET pinned = ?1 WHERE name = ?2",
        params![if pinned { 1 } else { 0 }, name],
    )?;
    Ok(())
}

/// Delete a skill. No-op (returns Ok) if the row doesn't exist.
pub fn delete(name: &str) -> Result<()> {
    let conn = get_db()?;
    conn.execute("DELETE FROM claude_skills WHERE name = ?1", params![name])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh in-memory SQLite with just the `claude_skills` schema —
    /// enough to test the table + indexes without spinning up the global
    /// pool. Use for migration / column-level assertions.
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open mem db");
        ensure_claude_skills_tables(&conn).unwrap();
        conn
    }

    fn err_kind(e: &anyhow::Error) -> Option<&'static str> {
        e.downcast_ref::<SkillError>().map(|s| s.kind)
    }

    /// Mirror `import_from_folder` but on a caller-owned connection so the
    /// tests don't touch the global rusqlite pool. The logic must stay in
    /// sync with the public `import_from_folder`.
    fn import_into(
        conn: &mut Connection,
        folder: &Path,
        overwrite: bool,
        now: i64,
    ) -> Result<ClaudeSkillRow> {
        if !folder.exists() {
            anyhow::bail!("folder does not exist: {}", folder.display());
        }
        if !folder.is_dir() {
            anyhow::bail!("not a directory: {}", folder.display());
        }
        let canon = fs::canonicalize(folder)
            .with_context(|| format!("failed to canonicalize {}", folder.display()))?;
        let skill_md_path = canon.join("SKILL.md");
        if !skill_md_path.exists() {
            anyhow::bail!("SKILL.md not found in {}", canon.display());
        }
        let source = fs::read_to_string(&skill_md_path)
            .with_context(|| format!("failed to read {}", skill_md_path.display()))?;
        let parsed = parse_skill_md(&source)?;
        validate_name(&parsed.name)?;
        validate_description(&parsed.description)?;
        validate_body(&parsed.body_md)?;
        let allowed_tools_json = match &parsed.allowed_tools {
            Some(tools) => Some(serde_json::to_string(tools)?),
            None => None,
        };
        let source_path = canon.to_string_lossy().to_string();
        let tx = conn.transaction()?;
        let existing: Option<(i64, bool, bool)> = tx
            .query_row(
                "SELECT id, enabled, pinned FROM claude_skills WHERE name = ?1",
                params![parsed.name],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)? != 0,
                        r.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .ok();
        let (id, enabled, pinned) = match existing {
            None => {
                tx.execute(
                    "INSERT INTO claude_skills
                        (name, description, body_md, allowed_tools_json,
                         source_path, imported_at, enabled, pinned)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0)",
                    params![
                        parsed.name,
                        parsed.description,
                        parsed.body_md,
                        allowed_tools_json,
                        source_path,
                        now,
                    ],
                )?;
                (tx.last_insert_rowid(), true, false)
            }
            Some((existing_id, existing_enabled, existing_pinned)) => {
                if !overwrite {
                    drop(tx);
                    return Err(err(
                        "name_collision",
                        format!("claude skill '{}' already exists", parsed.name),
                    ));
                }
                tx.execute(
                    "UPDATE claude_skills
                     SET description = ?1, body_md = ?2, allowed_tools_json = ?3,
                         source_path = ?4, imported_at = ?5
                     WHERE id = ?6",
                    params![
                        parsed.description,
                        parsed.body_md,
                        allowed_tools_json,
                        source_path,
                        now,
                        existing_id,
                    ],
                )?;
                (existing_id, existing_enabled, existing_pinned)
            }
        };
        tx.commit()?;
        Ok(ClaudeSkillRow {
            id,
            name: parsed.name,
            description: parsed.description,
            body_md: parsed.body_md,
            allowed_tools_json,
            source_path,
            imported_at: now,
            enabled,
            pinned,
        })
    }

    /// Write a SKILL.md (with arbitrary content) into a fresh temp dir and
    /// return the path to that dir. Caller keeps the `TempDir` alive for the
    /// life of the test.
    fn write_skill(dir: &tempfile::TempDir, content: &str) {
        std::fs::write(dir.path().join("SKILL.md"), content).unwrap();
    }

    const HAPPY_PATH_SKILL: &str = "---\nname: my-skill\ndescription: \
        Does a thing\nallowed-tools:\n  - Read\n  - Write\n  - Bash\n---\n\n\
        # My Skill\n\nFull body here.\n";

    #[test]
    fn migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_claude_skills_tables(&conn).expect("first");
        ensure_claude_skills_tables(&conn).expect("second must not error");
        ensure_claude_skills_tables(&conn).expect("third must not error");
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type='table' AND name='claude_skills'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "claude_skills table should exist exactly once");
        // Both indexes must exist exactly once.
        for idx in ["idx_claude_skills_enabled", "idx_claude_skills_pinned"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{idx} should exist exactly once");
        }
    }

    #[test]
    fn parse_frontmatter_extracts_name_description() {
        let parsed = parse_skill_md(HAPPY_PATH_SKILL).unwrap();
        assert_eq!(parsed.name, "my-skill");
        assert_eq!(parsed.description, "Does a thing");
        assert_eq!(
            parsed.allowed_tools.as_deref(),
            Some(&["Read".to_string(), "Write".to_string(), "Bash".to_string()][..])
        );
        assert!(parsed.body_md.starts_with("# My Skill"));
        assert!(parsed.body_md.contains("Full body here."));
    }

    #[test]
    fn parse_frontmatter_rejects_missing_dash_fence() {
        // No leading fence at all.
        let src = "name: foo\ndescription: bar\n---\n\nbody\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Opening fence but no closing fence.
        let src = "---\nname: foo\ndescription: bar\n\nbody without closing\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Empty file.
        let e = parse_skill_md("").unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Only blank lines.
        let e = parse_skill_md("\n\n   \n").unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
    }

    #[test]
    fn parse_frontmatter_rejects_missing_required_keys() {
        // Missing `name`.
        let src = "---\ndescription: only desc\n---\n\nbody\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Missing `description`.
        let src = "---\nname: only-name\n---\n\nbody\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Both missing — still one `bad_skill_md`, not two errors fused.
        let src = "---\n---\n\nbody\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
        // Bad YAML (unclosed list).
        let src = "---\nname: x\ndescription: d\nallowed-tools:\n  - [unclosed\n---\n\nbody\n";
        let e = parse_skill_md(src).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_skill_md"));
    }

    #[test]
    fn parse_allowed_tools_serializes_to_json_array() {
        let parsed = parse_skill_md(HAPPY_PATH_SKILL).unwrap();
        let json = serde_json::to_string(&parsed.allowed_tools.unwrap()).unwrap();
        assert_eq!(json, r#"["Read","Write","Bash"]"#);
        // Missing allowed-tools must yield None (not an empty Vec).
        let src = "---\nname: x\ndescription: d\n---\n\nbody\n";
        let parsed = parse_skill_md(src).unwrap();
        assert!(parsed.allowed_tools.is_none());
    }

    #[test]
    fn import_from_folder_validates_name_charset() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        // Space in name → bad_name.
        write_skill(&dir, "---\nname: bad name\ndescription: d\n---\n\nbody\n");
        let e = import_into(&mut conn, dir.path(), false, 100).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_name"));
        // Slash → bad_name.
        write_skill(&dir, "---\nname: bad/name\ndescription: d\n---\n\nbody\n");
        let e = import_into(&mut conn, dir.path(), false, 100).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_name"));
        // 65 chars → bad_name.
        let too_long = "a".repeat(65);
        write_skill(
            &dir,
            &format!("---\nname: {too_long}\ndescription: d\n---\n\nbody\n"),
        );
        let e = import_into(&mut conn, dir.path(), false, 100).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_name"));
        // Description too long → bad_description.
        let too_long_desc = "d".repeat(513);
        write_skill(
            &dir,
            &format!("---\nname: ok\ndescription: {too_long_desc}\n---\n\nbody\n"),
        );
        let e = import_into(&mut conn, dir.path(), false, 100).unwrap_err();
        assert_eq!(err_kind(&e), Some("bad_description"));
        // Happy path with the same temp dir succeeds.
        write_skill(&dir, HAPPY_PATH_SKILL);
        let row = import_into(&mut conn, dir.path(), false, 100).unwrap();
        assert_eq!(row.name, "my-skill");
    }

    #[test]
    fn import_from_folder_rejects_oversized_body() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        // Build a body just over 256 KiB.
        let huge = "x".repeat(MAX_BODY_BYTES + 1);
        let src = format!("---\nname: big\ndescription: d\n---\n\n{huge}\n");
        write_skill(&dir, &src);
        let e = import_into(&mut conn, dir.path(), false, 100).unwrap_err();
        assert_eq!(err_kind(&e), Some("body_too_large"));
    }

    #[test]
    fn import_from_folder_persists_canonical_source_path() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        let row = import_into(&mut conn, dir.path(), false, 100).unwrap();
        // The stored source_path must be the canonical form of the dir,
        // not the (possibly-symlinked or relative) input.
        let expected = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(row.source_path, expected);
        // And the row exists in the table at that path.
        let stored: String = conn
            .query_row(
                "SELECT source_path FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, expected);
    }

    #[test]
    fn name_collision_without_overwrite_errors() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        import_into(&mut conn, dir.path(), false, 100).unwrap();
        // A second import (same name) without overwrite must fail with
        // name_collision.
        let dir2 = tempfile::tempdir().unwrap();
        write_skill(&dir2, HAPPY_PATH_SKILL);
        let e = import_into(&mut conn, dir2.path(), false, 200).unwrap_err();
        assert_eq!(err_kind(&e), Some("name_collision"));
        // The original row is untouched — same source_path.
        let stored: String = conn
            .query_row(
                "SELECT source_path FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let expected_original = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(stored, expected_original);
    }

    #[test]
    fn name_collision_with_overwrite_preserves_enabled_and_pinned() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        import_into(&mut conn, dir.path(), false, 100).unwrap();
        // Flip both toggles on the live row.
        conn.execute(
            "UPDATE claude_skills SET enabled = 0, pinned = 1 WHERE name = 'my-skill'",
            [],
        )
        .unwrap();
        // Re-import with overwrite=true and a different description.
        let new_src = "---\nname: my-skill\ndescription: \
            Updated description\n---\n\n# New body\n";
        write_skill(&dir, new_src);
        let row = import_into(&mut conn, dir.path(), true, 200).unwrap();
        // The toggles survived the overwrite.
        assert!(!row.enabled, "enabled must be preserved across overwrite");
        assert!(row.pinned, "pinned must be preserved across overwrite");
        // The description / body / imported_at reflect the new file.
        let (desc, body, imported, enabled, pinned): (String, String, i64, i64, i64) = conn
            .query_row(
                "SELECT description, body_md, imported_at, enabled, pinned
                 FROM claude_skills WHERE name='my-skill'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(desc, "Updated description");
        assert!(body.contains("New body"));
        assert_eq!(imported, 200);
        assert_eq!(enabled, 0);
        assert_eq!(pinned, 1);
    }

    #[test]
    fn list_enabled_only_filters_correctly() {
        let conn = fresh_db();
        // Insert three rows directly (skipping import) so we can control
        // the enabled flag per row.
        let now = 100_i64;
        for (i, name) in ["alpha", "beta", "gamma"].iter().enumerate() {
            let enabled = if *name == "beta" { 0 } else { 1 };
            conn.execute(
                "INSERT INTO claude_skills
                    (name, description, body_md, allowed_tools_json,
                     source_path, imported_at, enabled, pinned)
                 VALUES (?1, ?2, '', NULL, '/x', ?3, ?4, 0)",
                params![name, format!("desc-{i}"), now, enabled],
            )
            .unwrap();
        }
        // enabled_only=false → all three, sorted by name.
        let mut stmt = conn
            .prepare("SELECT name FROM claude_skills ORDER BY name ASC")
            .unwrap();
        let all: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(all, vec!["alpha", "beta", "gamma"]);
        // enabled_only=true → no beta.
        let mut stmt = conn
            .prepare("SELECT name FROM claude_skills WHERE enabled = 1 ORDER BY name ASC")
            .unwrap();
        let on: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(on, vec!["alpha", "gamma"]);
    }

    #[test]
    fn get_returns_none_for_missing() {
        let conn = fresh_db();
        // Mirror `get` directly so the test stays pool-free.
        let row: Option<(i64,)> = conn
            .query_row(
                "SELECT id FROM claude_skills WHERE name = 'nope'",
                [],
                |r| Ok((r.get(0)?,)),
            )
            .ok();
        assert!(row.is_none());
    }

    #[test]
    fn set_enabled_toggles() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        import_into(&mut conn, dir.path(), false, 100).unwrap();
        // Default is enabled=1.
        let v: i64 = conn
            .query_row(
                "SELECT enabled FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 1);
        // Flip off.
        conn.execute(
            "UPDATE claude_skills SET enabled = 0 WHERE name = 'my-skill'",
            [],
        )
        .unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT enabled FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 0);
        // Flip back on.
        conn.execute(
            "UPDATE claude_skills SET enabled = 1 WHERE name = 'my-skill'",
            [],
        )
        .unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT enabled FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 1);
        // Toggling a missing row is a no-op (zero rows changed).
        let changed = conn
            .execute(
                "UPDATE claude_skills SET enabled = 0 WHERE name = 'missing'",
                [],
            )
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn set_pinned_toggles() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        import_into(&mut conn, dir.path(), false, 100).unwrap();
        // Default is pinned=0.
        let v: i64 = conn
            .query_row(
                "SELECT pinned FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 0);
        conn.execute(
            "UPDATE claude_skills SET pinned = 1 WHERE name = 'my-skill'",
            [],
        )
        .unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT pinned FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 1);
        conn.execute(
            "UPDATE claude_skills SET pinned = 0 WHERE name = 'my-skill'",
            [],
        )
        .unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT pinned FROM claude_skills WHERE name='my-skill'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, 0);
    }

    #[test]
    fn delete_removes_row() {
        let mut conn = fresh_db();
        let dir = tempfile::tempdir().unwrap();
        write_skill(&dir, HAPPY_PATH_SKILL);
        import_into(&mut conn, dir.path(), false, 100).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM claude_skills", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        conn.execute("DELETE FROM claude_skills WHERE name = 'my-skill'", [])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM claude_skills", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // Deleting an already-missing row is a no-op.
        let changed = conn
            .execute("DELETE FROM claude_skills WHERE name = 'missing'", [])
            .unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn list_pinned_bodies_only_returns_pinned() {
        let conn = fresh_db();
        // Three skills: one pinned+enabled, one pinned+disabled, one
        // unpinned+enabled. Only the first should appear in the output.
        for (name, body, pinned, enabled) in [
            ("alpha", "alpha body", 1, 1),
            ("beta", "beta body", 1, 0),
            ("gamma", "gamma body", 0, 1),
        ] {
            conn.execute(
                "INSERT INTO claude_skills
                    (name, description, body_md, allowed_tools_json,
                     source_path, imported_at, enabled, pinned)
                 VALUES (?1, 'd', ?2, NULL, '/x', 100, ?3, ?4)",
                params![name, body, enabled, pinned],
            )
            .unwrap();
        }
        let mut stmt = conn
            .prepare(
                "SELECT name, body_md FROM claude_skills
                 WHERE pinned = 1 AND enabled = 1 ORDER BY name ASC",
            )
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, vec![("alpha".to_string(), "alpha body".to_string())]);
    }
}
