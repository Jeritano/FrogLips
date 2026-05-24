import { useEffect, useRef, useState } from "react";
import type { ModelEntry, WorkflowCard } from "../../types";
import { loadAllPresets } from "../../lib/agent-presets";
import { useModalA11y } from "../../lib/use-modal-a11y";
import { generateAgentName } from "../../lib/agent-name";
import { isNonChatRepo } from "../../lib/chat-model-filter";
import { api } from "../../lib/tauri-api";

/** Origin rect the card flies in from / back to (the deck or a placed node). */
export interface FormOrigin {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  card: WorkflowCard;
  origin: FormOrigin | null;
  /**
   * True when the form is creating a brand-new card. On save the card
   * materializes on the canvas (not in the deck), so the form fades out in
   * place instead of flying back to the deck origin.
   */
  isNew: boolean;
  onSave: (card: WorkflowCard) => void;
  onClose: () => void;
}

/** All tool ids surfaced across the built-in presets — the explicit picker. */
const ALL_TOOLS = [
  "read_file", "list_dir", "search_files", "file_exists",
  "edit_file", "multi_edit", "write_file", "run_shell",
  "git_status", "git_diff", "git_log", "git_show", "git_branches", "git_commit",
  "read_pdf", "web_fetch", "web_search",
];

/**
 * Schedule grammar the Rust scheduler accepts: `every <n>m` / `every <n>h`
 * (interval) or `daily HH:MM` (clock time). Blank = manual run only.
 */
const HINT = "Use 'every 30m', 'every 2h', or 'daily 09:00'.";

function scheduleError(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  const every = v.match(/^every\s+(\d+)\s*([mh])$/);
  if (every) return Number(every[1]) > 0 ? null : HINT;
  const daily = v.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hh = Number(daily[1]);
    const mm = Number(daily[2]);
    return hh < 24 && mm < 60 ? null : HINT;
  }
  return HINT;
}

/**
 * Centered card-shaped form for creating or editing one agent card. It flies
 * in from `origin` (the deck or the placed node) on open and flies back on
 * save/cancel. The `--wf-fly-*` custom properties drive the fly transform;
 * all motion is gated by the global prefers-reduced-motion rule.
 */
export function CardForm({ card, origin, isNew, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const presets = loadAllPresets();
  const [draft, setDraft] = useState<WorkflowCard>(card);
  // `entered` flips on after first paint so the CSS transition runs from the
  // origin transform to the resting (centered) state.
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // A new card fades out in place on save (it lands on the canvas, not the
  // deck); cancel and edit-mode still fly back to the origin rect.
  const [fadeOut, setFadeOut] = useState(false);
  // Installed local models for the Model dropdown — blank = system default.
  const [models, setModels] = useState<ModelEntry[]>([]);

  useModalA11y({ open: true, onClose, containerRef: ref });
  // Re-seed the draft only when the form opens on a DIFFERENT card. Without
  // this guard, the parent re-emitting the same `card` (a new object identity
  // after any sibling state change) wipes in-flight edits the user has typed
  // into the form. Comparing by id is enough: the form is keyed to one card.
  useEffect(() => {
    setDraft((d) => (d.id === card.id ? d : card));
  }, [card]);

  useEffect(() => {
    api
      .listAllModels()
      .then((m) => {
        // Strip image-gen weight sets + their dep encoders even if the
        // Rust filter is missing. See src/lib/chat-model-filter.ts.
        const mlx = m.mlx.filter((e) => !isNonChatRepo(e.id));
        setModels([...mlx, ...m.ollama]);
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const schedErr = scheduleError(draft.schedule ?? "");

  function set<K extends keyof WorkflowCard>(key: K, value: WorkflowCard[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function toggleTool(tool: string) {
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(tool)
        ? d.tools.filter((t) => t !== tool)
        : [...d.tools, tool],
    }));
  }

  // Animate the card out, then run the callback once the transition ends.
  // `mode` "fly" returns it to the origin rect; "fade" dissolves it in place.
  // Falls through immediately under reduced motion (the transition is zeroed
  // there, so `transitionend` may not fire).
  function exit(then: () => void, mode: "fly" | "fade" = "fly") {
    const node = cardRef.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!node || reduce) {
      then();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      then();
    };
    node.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 400);
    if (mode === "fade") setFadeOut(true);
    else setLeaving(true);
  }

  function handleSave() {
    if (schedErr != null) return;
    // New card materializes on the canvas: fade out in place so the motion
    // never implies the card went back into the deck.
    exit(() => onSave(draft), isNew ? "fade" : "fly");
  }

  function handleCancel() {
    exit(onClose, "fly");
  }

  // Translate from card-center to origin-center; scale down to origin size.
  const flyStyle: React.CSSProperties = origin
    ? {
        ["--wf-fly-x" as string]: `${origin.x + origin.w / 2}px`,
        ["--wf-fly-y" as string]: `${origin.y + origin.h / 2}px`,
        ["--wf-fly-scale" as string]: String(
          Math.max(origin.w / 420, 0.12),
        ),
      }
    : {};

  const stateClass = fadeOut
    ? "is-leaving-fade"
    : leaving
      ? "is-leaving"
      : entered
        ? "is-entered"
        : "is-entering";

  return (
    <div
      className="wf-form-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Agent card"
    >
      <div
        className={`wf-form-card ${stateClass}`}
        ref={cardRef}
        style={flyStyle}
        data-testid="wf-card-form"
      >
        <div className="wf-form-inner" ref={ref}>
          <div className="wf-form-head">
            <span className="wf-form-title">{card.placed ? "Edit agent" : "New agent"}</span>
            <button
              type="button"
              className="wf-form-close"
              onClick={handleCancel}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="wf-form-body">
            <label className="wf-field">
              <span>Agent name</span>
              <div className="wf-name-row">
                <input
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Agent name"
                />
                <button
                  type="button"
                  className="wf-reroll"
                  onClick={() => set("name", generateAgentName())}
                  title="Reroll name"
                  aria-label="Reroll name"
                >
                  🎲
                </button>
              </div>
            </label>
            <label className="wf-field">
              <span>Role</span>
              <select value={draft.preset} onChange={(e) => set("preset", e.target.value)}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="wf-field">
              <span>Model</span>
              <select
                value={draft.model ?? ""}
                onChange={(e) => set("model", e.target.value || null)}
              >
                <option value="">System default</option>
                {models.map((m) => (
                  <option key={`${m.backend}:${m.id}`} value={m.id}>
                    {m.id}
                  </option>
                ))}
                {/* Keep a pinned model selectable even if it's no longer
                    in the installed list. */}
                {draft.model && !models.some((m) => m.id === draft.model) && (
                  <option value={draft.model}>{draft.model}</option>
                )}
              </select>
            </label>
            <label className="wf-field">
              <span>Instructions</span>
              <textarea
                value={draft.prompt}
                onChange={(e) => set("prompt", e.target.value)}
                rows={4}
                placeholder="What should this agent do?"
              />
            </label>
            <label className="wf-field">
              <span>Schedule (blank = manual)</span>
              <input
                value={draft.schedule ?? ""}
                onChange={(e) => set("schedule", e.target.value || null)}
                placeholder="every 30m  ·  daily 09:00"
                aria-invalid={schedErr != null}
              />
              {schedErr && <p className="wf-field-error" role="alert">{schedErr}</p>}
            </label>
            <label className="wf-field wf-field-check">
              <input
                type="checkbox"
                checked={draft.unattended === true}
                onChange={(e) => set("unattended", e.target.checked)}
              />
              <span>Auto-approve this card's tools on scheduled runs.</span>
            </label>
            <div className="wf-field">
              <span>Tools</span>
              <div className="wf-tool-grid">
                {ALL_TOOLS.map((tool) => (
                  <label key={tool} className="wf-tool-item">
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(tool)}
                      onChange={() => toggleTool(tool)}
                    />
                    {tool}
                  </label>
                ))}
              </div>
              <p className="wf-field-hint">No tools selected = role default tools.</p>
            </div>
          </div>
          <div className="wf-form-foot">
            <button type="button" className="wf-btn" onClick={handleCancel}>Cancel</button>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={handleSave}
              disabled={schedErr != null}
              title={schedErr ?? "Save card"}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
