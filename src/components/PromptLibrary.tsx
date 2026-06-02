import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBar } from "./ErrorBar";
import { useModalA11y } from "../lib/use-modal-a11y";
import {
  deleteCustomTemplate,
  extractVariables,
  generateTemplateId,
  loadAllTemplatesForManager,
  saveCustomTemplate,
  setBuiltInHidden,
  type PromptTemplate,
} from "../lib/prompt-templates";

/* ── Prompt library manager ─────────────────────────────────────────────
 *
 * Modal that lists every template, lets the user toggle built-in
 * visibility, edit/delete custom entries, and add new ones. State lives in
 * localStorage; this component just edits and re-reads.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called whenever the persisted set changes, so the parent can refresh. */
  onChange?: () => void;
}

interface Draft {
  id: string;
  name: string;
  trigger: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { id: "", name: "", trigger: "", body: "" };

export function PromptLibrary({ open, onClose, onChange }: Props) {
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Audit H-F1 (2026-05-27): previously the overlay had no role="dialog",
  // no aria-modal, no focus trap, no Escape handler — keyboard-only
  // users could tab into the underlying ChatWindow with the library
  // technically open. Wire the shared a11y kit so every modal in the
  // app behaves consistently.
  const boxRef = useRef<HTMLDivElement>(null);
  useModalA11y({ open, onClose, containerRef: boxRef });

  // Read fresh state on each render burst. Cheap (localStorage).
  const data = useMemo(
    () => (open ? loadAllTemplatesForManager() : null),
    [open, tick],
  );

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setErr(null);
    }
  }, [open]);

  if (!open || !data) return null;

  function bumpAndNotify() {
    setTick((n) => n + 1);
    onChange?.();
  }

  function startNew() {
    setErr(null);
    setDraft({ ...EMPTY_DRAFT, id: "" });
  }

  function startEdit(t: PromptTemplate) {
    setErr(null);
    setDraft({ id: t.id, name: t.name, trigger: t.trigger, body: t.body });
  }

  function commit() {
    if (!draft) return;
    const name = draft.name.trim();
    const trigger = draft.trigger.trim();
    const body = draft.body;
    if (!name || !trigger || !body.trim()) {
      setErr("Name, trigger, and body are all required.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trigger)) {
      setErr("Trigger must be alphanumeric (+ _ or -).");
      return;
    }
    const id = draft.id || generateTemplateId(trigger);
    saveCustomTemplate({
      id,
      name,
      trigger,
      body,
      variables: extractVariables(body),
    });
    setDraft(null);
    bumpAndNotify();
  }

  function remove(id: string) {
    deleteCustomTemplate(id);
    bumpAndNotify();
  }

  function toggleHidden(id: string, currentlyHidden: boolean) {
    setBuiltInHidden(id, !currentlyHidden);
    bumpAndNotify();
  }

  const { builtIns, custom, hiddenIds } = data;

  return (
    <div
      className="prompt-library-overlay"
      data-testid="prompt-library-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={boxRef}
        className="prompt-library"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt library"
      >
        <div className="prompt-library-head">
          <h3>Prompt library</h3>
          <button
            className="agent-settings-btn"
            onClick={onClose}
            aria-label="Close prompt library"
          >
            Close
          </button>
        </div>

        <div className="prompt-library-section">
          <div className="prompt-library-section-head">
            <strong>Built-ins</strong>
            <span className="agent-settings-hint">
              Can be hidden, not deleted. A custom trigger of the same name overrides.
            </span>
          </div>
          <ul className="prompt-library-list">
            {builtIns.map((t) => {
              const hidden = hiddenIds.has(t.id);
              return (
                <li key={t.id} data-testid={`prompt-builtin-${t.id}`}>
                  <div className="prompt-library-row">
                    <code className="prompt-trigger">/{t.trigger}</code>
                    <span className="prompt-name">{t.name}</span>
                    <button
                      className="agent-settings-btn"
                      onClick={() => toggleHidden(t.id, hidden)}
                    >
                      {hidden ? "Show" : "Hide"}
                    </button>
                  </div>
                  <div className="prompt-body-preview">{t.body}</div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="prompt-library-section">
          <div className="prompt-library-section-head">
            <strong>Custom</strong>
            <button
              className="agent-settings-btn"
              onClick={startNew}
              data-testid="prompt-library-new"
            >
              + New template
            </button>
          </div>
          {custom.length === 0 && !draft && (
            <div className="agent-settings-hint">
              No custom templates yet. Click + New template to add one.
            </div>
          )}
          <ul className="prompt-library-list">
            {custom.map((t) => (
              <li key={t.id} data-testid={`prompt-custom-${t.id}`}>
                <div className="prompt-library-row">
                  <code className="prompt-trigger">/{t.trigger}</code>
                  <span className="prompt-name">{t.name}</span>
                  <button
                    className="agent-settings-btn"
                    onClick={() => startEdit(t)}
                  >
                    Edit
                  </button>
                  <button
                    className="agent-settings-btn danger"
                    onClick={() => remove(t.id)}
                  >
                    Delete
                  </button>
                </div>
                <div className="prompt-body-preview">{t.body}</div>
              </li>
            ))}
          </ul>
        </div>

        {draft && (
          <div className="prompt-library-editor" data-testid="prompt-library-editor">
            <div className="prompt-library-section-head">
              <strong>{draft.id ? "Edit template" : "New template"}</strong>
            </div>
            <ErrorBar message={err} onDismiss={() => setErr(null)} />
            <label className="prompt-library-field">
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Refactor"
              />
            </label>
            <label className="prompt-library-field">
              <span>Trigger</span>
              <input
                value={draft.trigger}
                onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                placeholder="refactor"
              />
            </label>
            <label className="prompt-library-field">
              <span>Body</span>
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="Refactor {selection} for {goal}."
                rows={4}
              />
            </label>
            <div className="prompt-library-editor-actions">
              <button className="agent-settings-btn" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button
                className="agent-settings-btn primary"
                onClick={commit}
                data-testid="prompt-library-save"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
