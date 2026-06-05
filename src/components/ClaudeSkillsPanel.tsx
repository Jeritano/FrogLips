import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/tauri-api";
import { announce } from "../lib/announce";
import { logDiag } from "../lib/diagnostics";
import type { ClaudeSkillRow, ClaudeSkillSummary } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { ErrorBar } from "./ErrorBar";
import { useModalA11y } from "../lib/use-modal-a11y";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Claude Skills library panel. Lists every Anthropic-format SKILL.md
 * folder the user has imported into the global library. Chat-mode
 * agents discover skills via `list_claude_skills()` and mount one
 * with `load_claude_skill(name)` at runtime.
 *
 * Feature-detected: the Rust commands are landing in parallel with the
 * UI. When `api.claudeSkillList` is not present, the panel renders the
 * empty state with a hint that the feature isn't available yet instead
 * of crashing on an invoke that resolves to a missing handler.
 *
 * Layout mirrors the workflows `SkillsPanel`:
 *   - Modal overlay with a frosted-glass inner card.
 *   - Header: title + `[+ Import]` + close ×.
 *   - Body: empty state or table (name / desc / source path / chips / actions).
 *   - View-Body sub-modal: full body_md + parsed allowed_tools chips
 *     + Re-import button.
 *   - Delete uses ConfirmDialog with the risk-destructive variant.
 */
export function ClaudeSkillsPanel({ open, onClose }: Props) {
  const supported = "claudeSkillList" in api;

  const [list, setList] = useState<ClaudeSkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // View-body sub-modal carries the full row (we need body_md +
  // allowed_tools_json + source_path for the Re-import button).
  const [viewing, setViewing] = useState<ClaudeSkillRow | null>(null);

  // Two confirm-dialog flows: name-collision overwrite during import,
  // and destructive delete. Each stores the data it needs to act on.
  const [pendingOverwrite, setPendingOverwrite] = useState<
    | {
        folder: string;
        existingPath: string;
        skillName: string;
      }
    | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<ClaudeSkillSummary | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    setErr(null);
    try {
      const rows = await api.claudeSkillList();
      setList(rows);
    } catch (e) {
      setErr(`Load failed: ${e}`);
      logDiag({
        level: "warn",
        source: "claude-skills-panel",
        message: "claudeSkillList failed",
        detail: e,
      });
    } finally {
      setLoading(false);
    }
  }, [supported]);

  useEffect(() => {
    if (!open) return;
    setViewing(null);
    setPendingDelete(null);
    setPendingOverwrite(null);
    void refresh();
  }, [open, refresh]);

  /**
   * Parse an error thrown by `claude_skill_import` for the
   * `kind: name_collision` marker the Rust side emits when the skill
   * name already exists. Falls back to null on any other shape so the
   * caller surfaces it as a plain error toast.
   */
  function parseCollision(
    e: unknown,
  ): { existingPath: string; skillName: string } | null {
    // Tauri serializes thrown errors to whatever the Rust side returns.
    // The contract: a payload with `kind === "name_collision"` carrying
    // `existing_path` and `name`. Accept both an object and a JSON-ish
    // string with the marker.
    if (e && typeof e === "object") {
      const obj = e as Record<string, unknown>;
      if (
        obj.kind === "name_collision" &&
        typeof obj.existing_path === "string" &&
        typeof obj.name === "string"
      ) {
        return { existingPath: obj.existing_path, skillName: obj.name };
      }
    }
    const text = typeof e === "string" ? e : String(e ?? "");
    if (text.includes("name_collision")) {
      // Best-effort parse: look for an embedded JSON object.
      try {
        const match = text.match(/\{[^]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as Record<string, unknown>;
          if (
            parsed.kind === "name_collision" &&
            typeof parsed.existing_path === "string" &&
            typeof parsed.name === "string"
          ) {
            return {
              existingPath: parsed.existing_path,
              skillName: parsed.name,
            };
          }
        }
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  async function runImport(folder: string, overwrite: boolean) {
    if (!supported) return;
    setImporting(true);
    setErr(null);
    try {
      const row = await api.claudeSkillImport(folder, overwrite);
      announce(`Imported skill ${row.name}`);
      await refresh();
    } catch (e) {
      const collision = parseCollision(e);
      if (collision && !overwrite) {
        setPendingOverwrite({
          folder,
          existingPath: collision.existingPath,
          skillName: collision.skillName,
        });
        return;
      }
      const msg =
        e && typeof e === "object" && "message" in (e as Record<string, unknown>)
          ? String((e as { message: unknown }).message)
          : String(e);
      setErr(`Import failed: ${msg}`);
      logDiag({
        level: "warn",
        source: "claude-skills-panel",
        message: "claudeSkillImport failed",
        detail: e,
      });
    } finally {
      setImporting(false);
    }
  }

  async function onImportClick() {
    if (!supported || importing) return;
    let folder: string | null = null;
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const res = await openDialog({
        directory: true,
        multiple: false,
        title: "Import Claude Skill folder",
      });
      folder = Array.isArray(res) ? (res[0] ?? null) : res;
    } catch (e) {
      setErr(`Folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!folder) return; // user canceled — no-op per spec
    await runImport(folder, false);
  }

  async function onConfirmOverwrite() {
    if (!pendingOverwrite) return;
    const { folder } = pendingOverwrite;
    setPendingOverwrite(null);
    await runImport(folder, true);
  }

  async function onView(skill: ClaudeSkillSummary) {
    if (!supported) return;
    setErr(null);
    try {
      const full = await api.claudeSkillGet(skill.name);
      if (!full) {
        setErr(`Skill "${skill.name}" no longer exists.`);
        return;
      }
      setViewing(full);
    } catch (e) {
      setErr(`Inspect failed: ${e}`);
    }
  }

  async function onToggleEnabled(skill: ClaudeSkillSummary) {
    if (!supported) return;
    try {
      await api.claudeSkillSetEnabled(skill.name, !skill.enabled);
      announce(
        !skill.enabled
          ? `Enabled skill ${skill.name}`
          : `Disabled skill ${skill.name}`,
      );
      await refresh();
    } catch (e) {
      setErr(`Toggle failed: ${e}`);
    }
  }

  async function onTogglePinned(skill: ClaudeSkillSummary) {
    if (!supported) return;
    try {
      await api.claudeSkillSetPinned(skill.name, !skill.pinned);
      announce(
        !skill.pinned
          ? `Pinned skill ${skill.name}`
          : `Unpinned skill ${skill.name}`,
      );
      await refresh();
    } catch (e) {
      setErr(`Toggle failed: ${e}`);
    }
  }

  async function onConfirmDelete() {
    if (!pendingDelete || !supported) return;
    setDeleting(true);
    setErr(null);
    try {
      await api.claudeSkillDelete(pendingDelete.name);
      if (viewing?.name === pendingDelete.name) setViewing(null);
      announce(`Deleted skill ${pendingDelete.name}`);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setErr(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  async function onReimport(skill: ClaudeSkillRow) {
    await runImport(skill.source_path, true);
    // Refresh the viewer with the latest row content after re-import.
    try {
      const full = await api.claudeSkillGet(skill.name);
      if (full) setViewing(full);
    } catch {
      /* best-effort */
    }
  }

  const overlayRef = useRef<HTMLDivElement>(null);
  useModalA11y({
    open,
    onClose,
    containerRef: overlayRef,
    // Skip autofocus while a sub-modal owns focus — ConfirmDialog and
    // the body viewer each install their own a11y kit and will fight
    // us for the active element otherwise.
    autoFocus: !viewing && !pendingDelete && !pendingOverwrite,
  });

  if (!open) return null;

  return (
    <div
      className="cs-panel-overlay"
      data-testid="claude-skills-panel"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Skills"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cs-panel-box">
        <header className="cs-panel-header">
          <h2 className="cs-panel-title">Skills</h2>
          <button
            type="button"
            className="cs-panel-import"
            onClick={() => void onImportClick()}
            disabled={!supported || importing}
            data-testid="claude-skills-import"
          >
            {importing ? "Importing…" : "+ Import"}
          </button>
          <button
            type="button"
            className="cs-panel-close"
            onClick={onClose}
            aria-label="Close Skills panel"
            data-testid="claude-skills-close"
          >
            <X size={16} />
          </button>
        </header>

        {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}

        <div className="cs-panel-body">
          {!supported ? (
            <EmptyState
              icon="🧩"
              heading="Skills not yet available"
              sub="(claude skills feature not yet available)"
              data-testid="claude-skills-unsupported"
            />
          ) : list.length === 0 && !loading ? (
            <EmptyState
              icon="🧩"
              heading="No Skills imported"
              sub="Import a folder containing a SKILL.md file. The agent in chat mode can then call list_claude_skills() and load_claude_skill(name) to use it."
              data-testid="claude-skills-empty"
            />
          ) : (
            <SkillsTable
              skills={list}
              loading={loading}
              onView={onView}
              onToggleEnabled={onToggleEnabled}
              onTogglePinned={onTogglePinned}
              onDelete={(s) => setPendingDelete(s)}
            />
          )}
        </div>

        {viewing && (
          <BodyViewer
            skill={viewing}
            onClose={() => setViewing(null)}
            onReimport={() => void onReimport(viewing)}
            busy={importing}
          />
        )}

        {pendingOverwrite && (
          <ConfirmDialog
            ariaLabel={`Overwrite skill ${pendingOverwrite.skillName}`}
            data-testid="claude-skills-overwrite-confirm"
            boxClassName="risk-destructive"
            title={
              <>
                A skill named <code>{pendingOverwrite.skillName}</code> already
                exists at <code>{pendingOverwrite.existingPath}</code>. Overwrite
                with the new version from <code>{pendingOverwrite.folder}</code>?
              </>
            }
            onDismiss={() => {
              if (!importing) setPendingOverwrite(null);
            }}
            actions={
              <>
                <button
                  type="button"
                  className="agent-confirm-deny"
                  onClick={() => setPendingOverwrite(null)}
                  disabled={importing}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="agent-confirm-allow"
                  data-testid="claude-skills-overwrite-confirm-allow"
                  onClick={() => void onConfirmOverwrite()}
                  disabled={importing}
                >
                  {importing ? "Importing…" : "Overwrite"}
                </button>
              </>
            }
          >
            <div className="cs-confirm-body">
              The existing skill body and metadata will be replaced. This cannot
              be undone.
            </div>
          </ConfirmDialog>
        )}

        {pendingDelete && (
          <ConfirmDialog
            ariaLabel={`Delete skill ${pendingDelete.name}`}
            data-testid="claude-skills-delete-confirm"
            boxClassName="risk-destructive"
            title={
              <>
                Delete skill <code>{pendingDelete.name}</code>?
              </>
            }
            onDismiss={() => {
              if (!deleting) setPendingDelete(null);
            }}
            actions={
              <>
                <button
                  type="button"
                  className="agent-confirm-deny"
                  onClick={() => setPendingDelete(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="agent-confirm-allow"
                  data-testid="claude-skills-delete-confirm-allow"
                  onClick={() => void onConfirmDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </>
            }
          >
            <div className="cs-confirm-body">
              The skill will be removed from the global library. Chat agents
              will no longer see it. This cannot be undone.
            </div>
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}

/* ── Skills table ───────────────────────────────────────────────────────── */

interface TableProps {
  skills: ClaudeSkillSummary[];
  loading: boolean;
  onView: (s: ClaudeSkillSummary) => void;
  onToggleEnabled: (s: ClaudeSkillSummary) => void;
  onTogglePinned: (s: ClaudeSkillSummary) => void;
  onDelete: (s: ClaudeSkillSummary) => void;
}

function SkillsTable({
  skills,
  loading,
  onView,
  onToggleEnabled,
  onTogglePinned,
  onDelete,
}: TableProps) {
  return (
    <div className="cs-table-wrap">
      <table className="cs-table" data-testid="claude-skills-table">
        <thead>
          <tr>
            <th className="cs-col-name">Name</th>
            <th className="cs-col-desc">Description</th>
            <th className="cs-col-path">Source path</th>
            <th className="cs-col-status">Status</th>
            <th className="cs-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && skills.length === 0 && (
            <tr>
              <td colSpan={5} className="cs-table-loading">
                Loading…
              </td>
            </tr>
          )}
          {skills.map((s) => (
            <tr key={s.id} data-testid={`claude-skills-row-${s.name}`}>
              <td className="cs-cell-name" title={s.name}>
                {s.name}
              </td>
              <td className="cs-cell-desc">
                <span className="cs-cell-desc-clamp">{s.description}</span>
              </td>
              <td
                className="cs-cell-path"
                title={s.source_path}
                data-testid={`claude-skills-path-${s.name}`}
              >
                {s.source_path}
              </td>
              <td className="cs-cell-status">
                <span
                  className={
                    s.enabled ? "cs-chip cs-chip-enabled" : "cs-chip cs-chip-disabled"
                  }
                  data-testid={`claude-skills-chip-enabled-${s.name}`}
                >
                  {s.enabled ? "enabled" : "disabled"}
                </span>
                {s.pinned && (
                  <span
                    className="cs-chip cs-chip-pinned"
                    data-testid={`claude-skills-chip-pinned-${s.name}`}
                  >
                    pinned
                  </span>
                )}
              </td>
              <td className="cs-cell-actions">
                <button
                  type="button"
                  className="cs-btn"
                  onClick={() => onView(s)}
                  data-testid={`claude-skills-view-${s.name}`}
                >
                  View body
                </button>
                <button
                  type="button"
                  className="cs-btn"
                  onClick={() => onToggleEnabled(s)}
                  data-testid={`claude-skills-toggle-enabled-${s.name}`}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="cs-btn"
                  onClick={() => onTogglePinned(s)}
                  data-testid={`claude-skills-toggle-pinned-${s.name}`}
                >
                  {s.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  className="cs-btn cs-btn-danger"
                  onClick={() => onDelete(s)}
                  data-testid={`claude-skills-delete-${s.name}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Body viewer (sub-modal) ────────────────────────────────────────────── */

/**
 * Parse the `allowed_tools_json` string into a list of tool names. The
 * Anthropic SKILL.md frontmatter declares this as a JSON array of
 * strings; we tolerate a missing/empty payload and a malformed string
 * by returning an empty array rather than throwing.
 */
function parseAllowedTools(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function BodyViewer({
  skill,
  onClose,
  onReimport,
  busy,
}: {
  skill: ClaudeSkillRow;
  onClose: () => void;
  onReimport: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });
  const tools = parseAllowedTools(skill.allowed_tools_json);
  return (
    <div
      className="cs-body-overlay"
      data-testid="claude-skills-body-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="cs-body-box"
        role="dialog"
        aria-modal="true"
        aria-label={`Body for ${skill.name}`}
      >
        <header className="cs-body-header">
          <h3 className="cs-body-title">
            Skill · <code>{skill.name}</code>
          </h3>
          <button
            type="button"
            className="cs-panel-close"
            onClick={onClose}
            aria-label="Close body viewer"
          >
            <X size={16} />
          </button>
        </header>

        <div className="cs-body-meta">
          <div className="cs-body-meta-row">
            <span className="cs-body-meta-label">Source:</span>
            <code
              className="cs-body-meta-path"
              title={skill.source_path}
              data-testid="claude-skills-body-path"
            >
              {skill.source_path}
            </code>
            <button
              type="button"
              className="cs-btn"
              onClick={onReimport}
              disabled={busy}
              data-testid="claude-skills-reimport"
            >
              {busy ? "Re-importing…" : "Re-import"}
            </button>
          </div>
          {tools.length > 0 && (
            <div className="cs-body-meta-row">
              <span className="cs-body-meta-label">
                Skill expects: {tools.join(", ")}
              </span>
            </div>
          )}
          {tools.length > 0 && (
            <div
              className="cs-body-tools"
              data-testid="claude-skills-allowed-tools"
            >
              {tools.map((t) => (
                <span key={t} className="cs-chip cs-chip-tool">
                  {t}
                </span>
              ))}
            </div>
          )}
          {tools.length > 0 && (
            <div className="cs-body-meta-note">
              Froglips translates these at runtime.
            </div>
          )}
        </div>

        <pre className="cs-body-pre" data-testid="claude-skills-body-md">
          {skill.body_md}
        </pre>
      </div>
    </div>
  );
}
