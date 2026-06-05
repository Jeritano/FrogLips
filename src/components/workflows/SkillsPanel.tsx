import { useCallback, useEffect, useRef, useState } from "react";
import { Wrench, X } from "lucide-react";
import { api } from "../../lib/tauri-api";
import { logDiag } from "../../lib/diagnostics";
import type { SkillSummary } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { useModalA11y } from "../../lib/use-modal-a11y";

interface Props {
  workflowId: number;
  workflowName: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Workflows → Skills panel. Lists the procedural-memory skills an agent has
 * saved against this workflow via the `workflow_save_skill` tool, lets the
 * user inspect a skill's `steps_json`, and delete the ones they don't want
 * future agent runs to use.
 *
 * Feature-detected: the Rust commands are still rolling out alongside this
 * panel. When `api.workflowSkillList` is not present, the panel renders
 * the empty state with a hint that the feature isn't available yet instead
 * of crashing on an invoke that resolves to a missing handler.
 */
export function SkillsPanel({ workflowId, workflowName, open, onClose }: Props) {
  const supported = "workflowSkillList" in api;

  const [list, setList] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Sub-panel state: the currently-inspected skill's pretty-printed JSON.
  // We hold both the name (for the header) and the formatted body string.
  const [viewing, setViewing] = useState<{ name: string; body: string } | null>(null);

  // Deletion confirm flow. `pendingDelete` is the skill the user has armed
  // for deletion; the ConfirmDialog renders only when it's non-null.
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    setErr(null);
    try {
      const rows = await api.workflowSkillList(workflowId);
      setList(rows);
    } catch (e) {
      setErr(`Load failed: ${e}`);
      logDiag({
        level: "warn",
        source: "skills-panel",
        message: "workflowSkillList failed",
        detail: e,
      });
    } finally {
      setLoading(false);
    }
  }, [supported, workflowId]);

  // Refetch when the panel opens AND whenever `workflowId` changes while
  // open — the spec is explicit: switching workflows while the panel is
  // mounted must refresh against the new id. Also clear any sub-panel
  // / pending-delete state from the previous workflow.
  useEffect(() => {
    if (!open) return;
    setViewing(null);
    setPendingDelete(null);
    void refresh();
  }, [open, workflowId, refresh]);

  async function onViewSteps(skill: SkillSummary) {
    if (!supported) return;
    setErr(null);
    try {
      const full = await api.workflowSkillGet(workflowId, skill.name);
      if (!full) {
        setErr(`Skill "${skill.name}" no longer exists.`);
        return;
      }
      // Pretty-print the JSON for the steps viewer. Bad JSON falls back to
      // the raw payload so the user still sees something they can copy.
      let pretty = full.steps_json;
      try {
        pretty = JSON.stringify(JSON.parse(full.steps_json), null, 2);
      } catch {
        /* keep raw */
      }
      setViewing({ name: skill.name, body: pretty });
    } catch (e) {
      setErr(`Inspect failed: ${e}`);
    }
  }

  async function onConfirmDelete() {
    if (!pendingDelete || !supported) return;
    setDeleting(true);
    setErr(null);
    try {
      await api.workflowSkillDelete(workflowId, pendingDelete.name);
      // If the user was inspecting the same skill, close the sub-panel
      // since its steps_json is now gone.
      if (viewing?.name === pendingDelete.name) setViewing(null);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setErr(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  const overlayRef = useRef<HTMLDivElement>(null);
  // Skip autofocus while a sub-modal (ConfirmDialog or steps viewer) is up —
  // each owns its own a11y kit and will fight us for focus otherwise.
  useModalA11y({
    open,
    onClose,
    containerRef: overlayRef,
    autoFocus: !viewing && !pendingDelete,
  });

  if (!open) return null;

  return (
    <div
      className="skills-panel-overlay"
      data-testid="skills-panel"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Skills for ${workflowName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="skills-panel-box">
        <header className="skills-panel-header">
          <h2 className="skills-panel-title">
            Skills · <span className="skills-panel-wf">{workflowName}</span>
          </h2>
          <button
            type="button"
            className="skills-panel-close"
            onClick={onClose}
            aria-label="Close skills panel"
            data-testid="skills-panel-close"
          >
            <X size={16}/>
          </button>
        </header>

        {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}

        <div className="skills-panel-body">
          {!supported ? (
            <EmptyState
              icon={<Wrench size={24}/>}
              heading="Skills not yet available"
              sub="(skills feature not yet available)"
              data-testid="skills-panel-unsupported"
            />
          ) : list.length === 0 && !loading ? (
            <EmptyState
              icon={<Wrench size={24}/>}
              heading="No skills saved"
              sub="Skills are saved by your agents when they call `workflow_save_skill`. They survive across runs of this workflow."
              data-testid="skills-panel-empty"
            />
          ) : (
            <SkillsTable
              skills={list}
              onViewSteps={onViewSteps}
              onDelete={(s) => setPendingDelete(s)}
              loading={loading}
            />
          )}
        </div>

        {viewing && (
          <StepsViewer
            name={viewing.name}
            body={viewing.body}
            onClose={() => setViewing(null)}
          />
        )}

        {pendingDelete && (
          <ConfirmDialog
            ariaLabel={`Delete skill ${pendingDelete.name}`}
            data-testid="skills-delete-confirm"
            boxClassName="risk-destructive"
            title={<>Delete skill <code>{pendingDelete.name}</code>?</>}
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
                  data-testid="skills-delete-confirm-allow"
                  onClick={() => void onConfirmDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </>
            }
          >
            <div className="skills-confirm-body">
              This cannot be undone.
            </div>
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}

/* ── Skills table ───────────────────────────────────────────────────────── */

interface TableProps {
  skills: SkillSummary[];
  onViewSteps: (s: SkillSummary) => void;
  onDelete: (s: SkillSummary) => void;
  loading: boolean;
}

function SkillsTable({ skills, onViewSteps, onDelete, loading }: TableProps) {
  return (
    <div className="skills-table-wrap">
      <table className="skills-table" data-testid="skills-table">
        <thead>
          <tr>
            <th className="skills-col-name">Name</th>
            <th className="skills-col-desc">Description</th>
            <th className="skills-col-num">Invoked</th>
            <th className="skills-col-time">Last used</th>
            <th className="skills-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && skills.length === 0 && (
            <tr>
              <td colSpan={5} className="skills-table-loading">
                Loading…
              </td>
            </tr>
          )}
          {skills.map((s) => (
            <tr key={s.id} data-testid={`skills-row-${s.name}`}>
              <td className="skills-cell-name" title={s.name}>{s.name}</td>
              <td className="skills-cell-desc">
                <span className="skills-cell-desc-clamp">{s.description}</span>
              </td>
              <td className="skills-cell-num">{s.invocation_count}</td>
              <td className="skills-cell-time">{formatRelativeTime(s.last_used_at)}</td>
              <td className="skills-cell-actions">
                <button
                  type="button"
                  className="skills-btn"
                  onClick={() => onViewSteps(s)}
                  data-testid={`skills-view-${s.name}`}
                >
                  View steps
                </button>
                <button
                  type="button"
                  className="skills-btn skills-btn-danger"
                  onClick={() => onDelete(s)}
                  data-testid={`skills-delete-${s.name}`}
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

/* ── Steps viewer (inline sub-panel) ────────────────────────────────────── */

function StepsViewer({
  name,
  body,
  onClose,
}: {
  name: string;
  body: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });
  return (
    <div
      className="skills-steps-overlay"
      data-testid="skills-steps-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="skills-steps-box"
        role="dialog"
        aria-modal="true"
        aria-label={`Steps for ${name}`}
      >
        <header className="skills-steps-header">
          <h3 className="skills-steps-title">
            Steps · <code>{name}</code>
          </h3>
          <button
            type="button"
            className="skills-panel-close"
            onClick={onClose}
            aria-label="Close steps viewer"
          >
            <X size={16}/>
          </button>
        </header>
        <pre className="skills-steps-pre" data-testid="skills-steps-body">
          {body}
        </pre>
      </div>
    </div>
  );
}

/* ── Relative-time formatter ────────────────────────────────────────────── */

/**
 * Best-effort relative time for the "Last used" column. Falls back to
 * "Never" for null timestamps. Mirrors the bucket scheme used in the
 * model-browser tab so the chrome stays visually consistent across the app.
 */
function formatRelativeTime(ms: number | null): string {
  if (ms == null) return "Never";
  const diff = Date.now() - ms;
  // Future timestamp (clock skew, test fixtures with `Date.now() + N`) —
  // we still want a stable label rather than a negative number.
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

// Re-exported only so unit tests can pin the formatting behavior without
// touching the panel's React internals. Not part of the public API.
export const __test = { formatRelativeTime };
