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

/**
 * Curated picker — the SAFE-to-pick tool ids surfaced as checkboxes. NOT
 * every tool the runner can dispatch (see `agent-loop/tools.ts` for the
 * full list); the picker intentionally omits irreversible / destructive
 * tools (delete_path, kill_process, agent_undo) and out-of-process glue
 * (spawn_subagent, await_subagents, mcp__*) so the UI can't accidentally
 * grant a card high-blast-radius capability with a single click.
 *
 * Important: `draft.tools` may contain entries OUTSIDE this list (set via
 * direct DB edit, migrated from a future schema, etc.). The save path
 * MUST preserve those — see `toggleTool` and the picker's `ALL_TOOLS`
 * iteration below. Wiping unknown entries would silently downgrade a
 * card's permissions.
 */
const ALL_TOOLS = [
  // Filesystem read
  "read_file", "list_dir", "search_files", "file_exists",
  // Filesystem mutate
  "edit_file", "multi_edit", "write_file", "make_dir", "move_path", "copy_path",
  // Diff / hash inspection
  "diff_files", "hash_file",
  // Shell + automation
  "run_shell", "applescript_run", "open_app", "show_notification",
  // Git
  "git_status", "git_diff", "git_log", "git_show", "git_branches", "git_commit",
  // Knowledge / project search
  "find_definition", "find_references", "format_code", "search_project_knowledge",
  // PDF / web
  "read_pdf", "web_fetch", "web_search", "http_request",
  // UI / clipboard
  "screenshot", "clipboard_get", "clipboard_set",
  // Process inspection (kill_process intentionally omitted)
  "list_processes",
  // Filesystem watch
  "watch_path", "poll_watch", "stop_watch", "list_watches",
  // Image gen
  "generate_image",
  // Task management
  "task_create", "task_status", "task_list",
  // Interaction
  "ask_user",
];

/**
 * Schedule grammar the Rust scheduler accepts: `every <n>m` / `every <n>h`
 * (interval) or `daily HH:MM` (clock time). Blank = manual run only.
 */
const HINT = "Use 'every 30m', 'every 2h', or 'daily 09:00'.";

/**
 * Look up a model's backend by id. Used by the Model dropdown when the card's
 * `backend` field is null but the model still happens to be in the installed
 * list — picking the model alone should imply its backend rather than leaving
 * `backend` null and letting the runner guess (the old behaviour would route
 * an MLX-only model to Ollama and "model not found"). Returns null if the
 * model isn't installed locally (e.g. a `*:cloud` Ollama tag or a model the
 * user typed via DB edit).
 */
function findModelBackend(models: ModelEntry[], id: string): string | null {
  const hit = models.find((m) => m.id === id);
  return hit ? hit.backend : null;
}

function scheduleError(value: string): string | null {
  // Mirror Rust `parse_schedule` (workflows.rs:423) — it strips the
  // literal `every ` prefix THEN `trim()`s the remainder, so any extra
  // whitespace between `every` and the number is collapsed. The form
  // must match that tolerance to avoid blocking edits on legacy data.
  //
  // Restrict separators to ASCII whitespace ONLY (`[ \t]`) — JS `\s`
  // also matches NBSP, en/em spaces, line separators, and ideographic
  // space, all of which Rust's `strip_prefix("every ")` rejects.
  // Without this restriction a value pasted from a word processor
  // (smart-quote whitespace) saves cleanly through the form, the
  // scheduler reads it, returns `None`, and the card silently never
  // fires. Strict ASCII keeps the two parsers in lockstep.
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  const every = v.match(/^every[ \t]+(\d+)[ \t]*([mh])$/);
  if (every) return Number(every[1]) > 0 ? null : HINT;
  const daily = v.match(/^daily[ \t]+(\d{1,2}):(\d{2})$/);
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
  // Loading state for the model dropdown. `null` = settled; string = error.
  // Without this, a slow / failed `listAllModels` shows an empty dropdown with
  // no signal whether models are loading, missing, or the call simply failed.
  const [modelsState, setModelsState] = useState<"loading" | "ok" | "error">("loading");

  useModalA11y({ open: true, onClose, containerRef: ref });
  // Re-seed the draft only when the form opens on a DIFFERENT card. Without
  // this guard, the parent re-emitting the same `card` (a new object identity
  // after any sibling state change) wipes in-flight edits the user has typed
  // into the form. Comparing by id is enough: the form is keyed to one card.
  useEffect(() => {
    setDraft((d) => (d.id === card.id ? d : card));
  }, [card]);

  useEffect(() => {
    let cancelled = false;
    setModelsState("loading");
    api
      .listAllModels()
      .then((m) => {
        if (cancelled) return;
        // Strip image-gen weight sets + their dep encoders even if the
        // Rust filter is missing. See src/lib/chat-model-filter.ts.
        const mlx = m.mlx.filter((e) => !isNonChatRepo(e.id));
        setModels([...mlx, ...m.ollama]);
        setModelsState("ok");
      })
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setModelsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-heal: once the installed-models list lands, if the draft has a model
  // pinned but no backend (legacy cards, pre-fix data), look up the model's
  // backend and copy it onto the draft. Without this, opening + saving an
  // existing card keeps `backend=null`, which forces the runner to fall back
  // to the default backend at run time — fine for Ollama, broken for MLX.
  // The dropdown's `onChange` already does this for fresh picks; this covers
  // the "saved a long time ago, never re-picked" case.
  useEffect(() => {
    if (modelsState !== "ok") return;
    if (!draft.model || draft.backend) return;
    const inferred = findModelBackend(models, draft.model);
    if (inferred) {
      setDraft((d) =>
        d.model && !d.backend ? { ...d, backend: inferred } : d,
      );
    }
  }, [modelsState, models, draft.model, draft.backend]);

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
                // Option values are encoded as `${backend}::${id}` so picking a
                // model also pins its backend in one step. Previously the
                // dropdown only saved `id`, leaving `card.backend` untouched —
                // a card switched from an Ollama model to an MLX model kept
                // backend=ollama and the run would hit "model not found" on
                // the wrong daemon. The `::` separator avoids the `:` used
                // inside Ollama tag suffixes (e.g. `model:q4_K`, `model:cloud`).
                value={
                  draft.model
                    ? `${draft.backend ?? findModelBackend(models, draft.model) ?? ""}::${draft.model}`
                    : ""
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    // "System default" — clear both pins; runtime falls back.
                    setDraft((d) => ({ ...d, model: null, backend: null }));
                    return;
                  }
                  const sep = v.indexOf("::");
                  if (sep < 0) {
                    // Defensive: a malformed value shouldn't corrupt draft. Just
                    // accept it as a model id and leave backend untouched.
                    set("model", v);
                    return;
                  }
                  const backend = v.slice(0, sep) || null;
                  const id = v.slice(sep + 2);
                  setDraft((d) => ({ ...d, model: id, backend }));
                }}
                disabled={modelsState === "loading"}
              >
                <option value="">
                  {modelsState === "loading"
                    ? "Loading models…"
                    : modelsState === "error"
                      ? "System default (model list failed to load)"
                      : "System default"}
                </option>
                {models.map((m) => (
                  <option key={`${m.backend}::${m.id}`} value={`${m.backend}::${m.id}`}>
                    {m.id} ({m.backend})
                  </option>
                ))}
                {/* Keep a pinned model selectable even if it's no longer in
                    the installed list (e.g. a `*:cloud` tag, an MLX model
                    that was deleted, or a Novita-only model on a feature
                    branch). Encode with the card's existing backend so save
                    is non-destructive. */}
                {draft.model && !models.some((m) => m.id === draft.model) && (
                  <option
                    value={`${draft.backend ?? ""}::${draft.model}`}
                  >
                    {draft.model}
                    {draft.backend ? ` (${draft.backend})` : " (pinned)"}
                  </option>
                )}
              </select>
              {modelsState === "error" && (
                <small className="wf-field-hint" style={{ color: "var(--danger, #d33)" }}>
                  Could not load the installed-models list. Check that Ollama is
                  running and MLX is set up, then reopen this dialog.
                </small>
              )}
            </label>
            <label className="wf-field">
              <span>System prompt (optional)</span>
              <textarea
                value={draft.systemPrompt ?? ""}
                onChange={(e) =>
                  set("systemPrompt", e.target.value === "" ? null : e.target.value)
                }
                rows={3}
                placeholder="Persona, constraints, output format. Leave blank to inherit from Role."
                maxLength={16_384}
              />
              <small className="wf-field-hint">
                Overrides the Role's system prompt for THIS card only. Use it to
                give one agent a different persona, output format, or hard
                constraints without making a new Role. Blank = use the Role's
                default.
              </small>
            </label>
            <label className="wf-field">
              <span>Instructions</span>
              <textarea
                value={draft.prompt}
                onChange={(e) => set("prompt", e.target.value)}
                rows={4}
                placeholder="What should this agent do? (sent as the user message)"
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
              <span>
                Auto-approve this agent's tool calls (normal-risk only).
              </span>
            </label>
            <p className="wf-field-hint" style={{ marginTop: "-4px" }}>
              Skips the approval modal for tools in this agent's list when the
              shell-risk classifier rates the call as normal. Destructive shapes
              (<code>rm&nbsp;-rf</code>, <code>sudo</code>, <code>kill</code>,{" "}
              <code>delete_path</code>, etc.) and MCP-routed tools still
              gate. Applies to manual <em>and</em> scheduled runs.
            </p>
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
