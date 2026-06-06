import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  ModelEntry,
  WorkflowCard,
  WorkflowNodeConfig,
  WorkflowNodeType,
  WorkflowRoute,
} from "../../types";
import { WORKFLOW_CARD_COLORS, WORKFLOW_NODE_TYPES } from "../../types";
import { loadAllPresets } from "../../lib/agent-presets";
import { useModalA11y } from "../../lib/use-modal-a11y";
import { generateAgentName } from "../../lib/agent-name";
import { api } from "../../lib/tauri-api";
import {
  applyMasterToggle,
  defaultCollapsed,
  loadCollapseState,
  masterStateOf,
  resolveToolGroups,
  saveCollapseState,
  type CollapseMap,
} from "./tool-categories";

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
  "run_shell", "run_code", "applescript_run", "open_app", "show_notification",
  // Git
  "git_status", "git_diff", "git_log", "git_show", "git_branches", "git_commit",
  // Knowledge / project search
  "find_definition", "find_references", "format_code", "search_project_knowledge", "calculate",
  // Long-term semantic memory
  "recall_memory", "remember",
  // PDF / web
  "read_pdf", "web_fetch", "web_search", "http_request",
  // UI / clipboard
  "screenshot", "clipboard_get", "clipboard_set",
  // Process inspection (kill_process intentionally omitted)
  "list_processes",
  // Filesystem watch
  "watch_path", "poll_watch", "stop_watch", "list_watches",
  // Image gen
  // Task management
  "task_create", "task_status", "task_list",
  // Interaction
  "ask_user",
  // Procedural memory (workflow skills) — saved sequences of tool calls
  // that future runs can replay by name.
  "workflow_save_skill", "workflow_list_skills", "workflow_get_skill",
  "workflow_invoke_skill", "workflow_delete_skill",
  // Claude Skills (imported Anthropic SKILL.md packages) — list/load the
  // user's imported skill library. Useful in workflow agents that want
  // to mount domain knowledge on demand instead of carrying the body in
  // the card's system prompt.
  "list_claude_skills", "load_claude_skill",
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
        setModels([...m.mlx, ...m.ollama]);
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
              <X size={16}/>
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
              <span>Node type</span>
              <select
                value={draft.nodeType ?? "agent"}
                onChange={(e) => set("nodeType", e.target.value as WorkflowNodeType)}
              >
                {WORKFLOW_NODE_TYPES.map((nt) => (
                  <option key={nt.value} value={nt.value}>{nt.label}</option>
                ))}
              </select>
              <small className="wf-field-hint">
                {WORKFLOW_NODE_TYPES.find((nt) => nt.value === (draft.nodeType ?? "agent"))?.blurb}
              </small>
            </label>
            {draft.nodeType && draft.nodeType !== "agent" && (
              <NodeConfigEditor
                nodeType={draft.nodeType}
                config={draft.nodeConfig ?? {}}
                models={models}
                presets={presets}
                onChange={(cfg) => set("nodeConfig", cfg)}
              />
            )}
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
            {/* System prompt + Instructions are collapsible to tame the
                form's vertical sprawl. `<details>` is native + a11y-free.
                System prompt starts COLLAPSED (optional override most
                cards leave blank); Instructions starts OPEN (the primary
                field). A "• set" hint on the summary shows when a
                collapsed System prompt actually carries content so it's
                not silently hidden. */}
            <details className="wf-field wf-collapse">
              <summary className="wf-collapse-summary">
                <span>System prompt (optional)</span>
                {(draft.systemPrompt ?? "").trim() !== "" && (
                  <span className="wf-collapse-badge" title="This card has a custom system prompt">
                    • set
                  </span>
                )}
              </summary>
              <div className="wf-collapse-body">
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
              </div>
            </details>
            <details className="wf-field wf-collapse" open>
              <summary className="wf-collapse-summary">
                <span>Instructions</span>
              </summary>
              <div className="wf-collapse-body">
                <textarea
                  value={draft.prompt}
                  onChange={(e) => set("prompt", e.target.value)}
                  rows={4}
                  placeholder="What should this agent do? (sent as the user message)"
                />
              </div>
            </details>
            {/* Card color theme — colour-code agents on a busy canvas. */}
            <div className="wf-field">
              <span>Card color</span>
              <div className="wf-color-row" role="radiogroup" aria-label="Card accent color">
                {WORKFLOW_CARD_COLORS.map((c) => {
                  const selected = (draft.color ?? null) === c.value;
                  return (
                    <button
                      key={c.name}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`wf-color-swatch${selected ? " selected" : ""}${c.value === null ? " wf-color-default" : ""}`}
                      style={c.value ? { background: c.value } : undefined}
                      title={c.name}
                      aria-label={c.name}
                      onClick={() => set("color", c.value)}
                    />
                  );
                })}
              </div>
            </div>
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
                Auto-approve this agent's tool calls.
              </span>
            </label>
            <p className="wf-field-hint" style={{ marginTop: "-4px" }}>
              When checked, this agent runs every tool call it issues without
              prompting. Applies to manual and scheduled runs. Leave unchecked
              if you want to review each tool call before it executes.
            </p>
            {/* Phase 1.3 — per-card model params. Three optional inputs;
                blank = backend default. Kept in a single row so the form
                doesn't sprawl. */}
            <div className="wf-field" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <label>
                <span>Temperature (0–2)</span>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  placeholder="default"
                  value={draft.params?.temperature ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    // Clamp on write — the HTML min/max are advisory for typed
                    // input, so an out-of-range value would otherwise persist
                    // and run live this session (it only self-heals on reload).
                    set("params", {
                      ...(draft.params ?? {}),
                      temperature: Number.isFinite(v) ? Math.min(2, Math.max(0, v as number)) : null,
                    });
                  }}
                />
              </label>
              <label>
                <span>Top-p (0–1)</span>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  placeholder="default"
                  value={draft.params?.top_p ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    set("params", {
                      ...(draft.params ?? {}),
                      top_p: Number.isFinite(v) ? Math.min(1, Math.max(0, v as number)) : null,
                    });
                  }}
                />
              </label>
              <label>
                <span>Max tokens</span>
                <input
                  type="number"
                  step="64"
                  min={1}
                  placeholder="default"
                  value={draft.params?.max_tokens ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    set("params", { ...(draft.params ?? {}), max_tokens: Number.isFinite(v) && v! > 0 ? Math.floor(v!) : null });
                  }}
                />
              </label>
            </div>
            {/* Phase 1.6 — retry policy. Two inputs; max=0 (default)
                disables retries. */}
            <div className="wf-field" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label>
                <span>Retry on error (0–5)</span>
                <input
                  type="number"
                  step="1"
                  min={0}
                  max={5}
                  placeholder="0 (no retry)"
                  value={draft.retry?.max ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? 0 : Math.max(0, Math.min(5, Math.floor(Number(e.target.value) || 0)));
                    if (v === 0) {
                      set("retry", null);
                    } else {
                      set("retry", { max: v, backoff_ms: draft.retry?.backoff_ms ?? 1000 });
                    }
                  }}
                />
              </label>
              <label>
                <span>Backoff ms</span>
                <input
                  type="number"
                  step="100"
                  min={0}
                  max={60000}
                  placeholder="1000"
                  value={draft.retry?.backoff_ms ?? ""}
                  disabled={!draft.retry || draft.retry.max === 0}
                  onChange={(e) => {
                    const v = e.target.value === "" ? 1000 : Math.max(0, Math.min(60_000, Math.floor(Number(e.target.value) || 0)));
                    if (draft.retry && draft.retry.max > 0) {
                      set("retry", { ...draft.retry, backoff_ms: v });
                    }
                  }}
                />
              </label>
            </div>
            <ToolPicker
              selected={draft.tools}
              onChange={(next) => set("tools", next)}
              onToggleOne={toggleTool}
            />
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

/* ── Orchestration node config editor ────────────────────────────────────
 * Shown only for non-"agent" node types. Renders the subset of
 * WorkflowNodeConfig fields relevant to the active node type. Each control
 * writes through `patch`, which merges one key into the config object so the
 * other fields survive. Numbers are clamped to the same bounds the loader
 * (`normalizeNodeConfig`) enforces so the live value matches what persists.
 */
function NodeConfigEditor({
  nodeType,
  config,
  models,
  presets,
  onChange,
}: {
  nodeType: WorkflowNodeType;
  config: WorkflowNodeConfig;
  models: ModelEntry[];
  presets: Array<{ id: string; name: string }>;
  onChange: (cfg: WorkflowNodeConfig) => void;
}) {
  const patch = (p: Partial<WorkflowNodeConfig>) => onChange({ ...config, ...p });
  const num = (v: string, lo: number, hi: number): number | undefined => {
    if (v === "") return undefined;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
  };

  return (
    <div className="wf-field" style={{ border: "1px solid var(--border-hairline, #2a2a2a)", borderRadius: 8, padding: 10, display: "grid", gap: 10 }}>
      <span style={{ fontWeight: 600 }}>Orchestration settings</span>

      {(nodeType === "moa" || nodeType === "consistency") && (
        <>
          <label>
            <span>{nodeType === "moa" ? "Proposers" : "Samples"} (2–8)</span>
            <input
              type="number" min={2} max={8} step={1}
              placeholder={nodeType === "moa" ? "3" : "5"}
              value={config.members ?? ""}
              onChange={(e) => patch({ members: num(e.target.value, 2, 8) })}
            />
          </label>
          {nodeType === "consistency" && (
            <label>
              <span>Aggregate by</span>
              <select
                value={config.voteMode ?? "synth"}
                onChange={(e) => patch({ voteMode: e.target.value as "synth" | "vote" })}
              >
                <option value="synth">Merge (synthesize)</option>
                <option value="vote">Majority vote</option>
              </select>
            </label>
          )}
          <label>
            <span>Synthesis instruction (optional)</span>
            <textarea
              rows={2}
              placeholder="How to merge the proposals into one answer."
              value={config.synthPrompt ?? ""}
              onChange={(e) => patch({ synthPrompt: e.target.value || null })}
            />
          </label>
          <NodeModelSelect
            label="Synthesis model (optional)"
            models={models}
            model={config.synthModel ?? null}
            backend={config.synthBackend ?? null}
            onChange={(m, b) => patch({ synthModel: m, synthBackend: b })}
          />
          <small className="wf-field-hint">
            The {nodeType === "moa" ? "proposers" : "samples"} run in parallel against the card's model.
            Same-model fan-out is cheap on RAM — Ollama loads the model once and serves the
            requests concurrently (only KV-cache grows). Choosing a <em>different</em> synthesis model
            loads a second model, so leave it blank on a memory-tight machine.
          </small>
        </>
      )}

      {nodeType === "critic" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label>
              <span>Max iterations (1–6)</span>
              <input
                type="number" min={1} max={6} step={1} placeholder="3"
                value={config.maxIters ?? ""}
                onChange={(e) => patch({ maxIters: num(e.target.value, 1, 6) })}
              />
            </label>
            <label>
              <span>Pass score (0–100)</span>
              <input
                type="number" min={0} max={100} step={1} placeholder="80"
                value={config.passThreshold ?? ""}
                onChange={(e) => patch({ passThreshold: num(e.target.value, 0, 100) })}
              />
            </label>
          </div>
          <label>
            <span>Critic instruction (optional)</span>
            <textarea
              rows={2}
              placeholder="How the critic should judge + score the draft."
              value={config.criticPrompt ?? ""}
              onChange={(e) => patch({ criticPrompt: e.target.value || null })}
            />
          </label>
          <NodeModelSelect
            label="Critic model (optional)"
            models={models}
            model={config.criticModel ?? null}
            backend={config.criticBackend ?? null}
            onChange={(m, b) => patch({ criticModel: m, criticBackend: b })}
          />
        </>
      )}

      {nodeType === "cascade" && (
        <>
          <label>
            <span>Escalate if score below (0–100)</span>
            <input
              type="number" min={0} max={100} step={1} placeholder="70"
              value={config.passThreshold ?? ""}
              onChange={(e) => patch({ passThreshold: num(e.target.value, 0, 100) })}
            />
          </label>
          <NodeModelSelect
            label="Escalation model (stronger / :cloud)"
            models={models}
            model={config.escalateModel ?? null}
            backend={config.escalateBackend ?? null}
            onChange={(m, b) => patch({ escalateModel: m, escalateBackend: b })}
          />
          <NodeModelSelect
            label="Scorer model (optional)"
            models={models}
            model={config.criticModel ?? null}
            backend={config.criticBackend ?? null}
            onChange={(m, b) => patch({ criticModel: m, criticBackend: b })}
          />
        </>
      )}

      {nodeType === "router" && (
        <>
          <RouteEditor
            routes={config.routes ?? []}
            models={models}
            presets={presets}
            onChange={(routes) => patch({ routes })}
          />
          <NodeModelSelect
            label="Classifier model (optional)"
            models={models}
            model={config.routerModel ?? null}
            backend={config.routerBackend ?? null}
            onChange={(m, b) => patch({ routerModel: m, routerBackend: b })}
          />
        </>
      )}

      {nodeType === "blackboard" && (
        <label>
          <span>Operation</span>
          <select
            value={config.blackboardOp ?? "snapshot"}
            onChange={(e) => patch({ blackboardOp: e.target.value as "summarize" | "snapshot" | "clear" })}
          >
            <option value="snapshot">Snapshot (dump shared state)</option>
            <option value="summarize">Summarize (brief the next agent)</option>
            <option value="clear">Clear (reset shared state)</option>
          </select>
        </label>
      )}

      {nodeType === "budget" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label>
              <span>Max tokens</span>
              <input
                type="number" min={1} step={64} placeholder="unlimited"
                value={config.maxTokens ?? ""}
                onChange={(e) => patch({ maxTokens: num(e.target.value, 1, 1_000_000) })}
              />
            </label>
            <label>
              <span>Max seconds</span>
              <input
                type="number" min={1} step={1} placeholder="unlimited"
                value={config.maxMs != null ? Math.round(config.maxMs / 1000) : ""}
                onChange={(e) => {
                  const s = num(e.target.value, 1, 3600);
                  patch({ maxMs: s == null ? null : s * 1000 });
                }}
              />
            </label>
          </div>
          <label>
            <span>When ceiling hit</span>
            <select
              value={config.onExceed ?? "best"}
              onChange={(e) => patch({ onExceed: e.target.value as "stop" | "best" })}
            >
              <option value="best">Return best effort so far</option>
              <option value="stop">Fail the card</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/** Model dropdown that pins backend alongside the id (backend::id encoding),
 *  matching the main Model picker. Empty = inherit the card's model. */
function NodeModelSelect({
  label,
  models,
  model,
  backend,
  onChange,
}: {
  label: string;
  models: ModelEntry[];
  model: string | null;
  backend: string | null;
  onChange: (model: string | null, backend: string | null) => void;
}) {
  const value = model ? `${backend ?? findModelBackend(models, model) ?? ""}::${model}` : "";
  return (
    <label>
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") { onChange(null, null); return; }
          const sep = v.indexOf("::");
          if (sep < 0) { onChange(v, null); return; }
          onChange(v.slice(sep + 2), v.slice(0, sep) || null);
        }}
      >
        <option value="">Inherit card model</option>
        {models.map((m) => (
          <option key={`${m.backend}::${m.id}`} value={`${m.backend}::${m.id}`}>
            {m.id} ({m.backend})
          </option>
        ))}
        {model && !models.some((m) => m.id === model) && (
          <option value={`${backend ?? ""}::${model}`}>
            {model}{backend ? ` (${backend})` : " (pinned)"}
          </option>
        )}
      </select>
    </label>
  );
}

/** Add/remove/edit the candidate routes for a router node. */
function RouteEditor({
  routes,
  models,
  presets,
  onChange,
}: {
  routes: WorkflowRoute[];
  models: ModelEntry[];
  presets: Array<{ id: string; name: string }>;
  onChange: (routes: WorkflowRoute[]) => void;
}) {
  const update = (i: number, p: Partial<WorkflowRoute>) =>
    onChange(routes.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(routes.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([...routes, { label: "", when: "", model: null, backend: null, preset: null }]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <span>Routes</span>
      {routes.length === 0 && (
        <small className="wf-field-hint">No routes yet — add at least one so the classifier has somewhere to send the task.</small>
      )}
      {routes.map((r, i) => (
        <div key={i} style={{ display: "grid", gap: 4, border: "1px solid var(--border-hairline, #2a2a2a)", borderRadius: 6, padding: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 6 }}>
            <input placeholder="label (e.g. code)" value={r.label} onChange={(e) => update(i, { label: e.target.value })} />
            <input placeholder="when… (e.g. task is about programming)" value={r.when} onChange={(e) => update(i, { when: e.target.value })} />
            <button type="button" className="wf-btn" onClick={() => remove(i)} title="Remove route"><X size={14}/></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <NodeModelSelect
              label="Model"
              models={models}
              model={r.model ?? null}
              backend={r.backend ?? null}
              onChange={(m, b) => update(i, { model: m, backend: b })}
            />
            <label>
              <span>Role</span>
              <select value={r.preset ?? ""} onChange={(e) => update(i, { preset: e.target.value || null })}>
                <option value="">Inherit card role</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}
      <button type="button" className="wf-btn" onClick={add}>+ Add route</button>
    </div>
  );
}

/* ── Grouped tool picker ─────────────────────────────────────────────────
 * Renders ALL_TOOLS bucketed by `TOOL_CATEGORIES`. Each group has:
 *   - a header row with a tri-state master checkbox (none/some/all)
 *   - a disclosure ▸/▾ toggle that remembers collapse state in localStorage
 *   - "N of M selected" indicator
 * Tools not in any category surface in an auto-generated "Other" group
 * so a contributor adding a new tool without categorizing it produces a
 * visible signal instead of silent omission.
 */
function ToolPicker({
  selected,
  onChange,
  onToggleOne,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  onToggleOne: (tool: string) => void;
}) {
  // Memoize group resolution — TOOL_CATEGORIES is constant, ALL_TOOLS is
  // module-constant; the result only changes if a contributor edits the
  // source. Recomputing per-render is fine but the memo also keeps the
  // dev-console warning from firing on every render of a card.
  const groups = useMemo(() => resolveToolGroups(ALL_TOOLS), []);

  const [collapse, setCollapse] = useState<CollapseMap>(() => loadCollapseState());

  const toggleCollapse = (id: string, defaultClosed: boolean) => {
    setCollapse((prev) => {
      // If the user has never touched this group, prev[id] is undefined
      // and the rule-based default applies. Toggle inverts whatever the
      // user is currently looking at — defaultClosed when undefined.
      const current = prev[id] ?? defaultClosed;
      const next = { ...prev, [id]: !current };
      saveCollapseState(next);
      return next;
    });
  };

  return (
    <div className="wf-field">
      <span>Tools</span>
      <div className="wf-tool-categories">
        {groups.map((cat) => {
          const master = masterStateOf(selected, cat.tools);
          const hits = cat.tools.reduce(
            (n, t) => n + (selected.includes(t) ? 1 : 0),
            0,
          );
          const ruleDefault = defaultCollapsed(hits, cat.tools.length);
          const isCollapsed = collapse[cat.id] ?? ruleDefault;
          // Layout discipline: every interactive control inside the
          // picker is a <button>, not a <label>+<input type=checkbox>.
          // The native-checkbox approach went through three regressions
          // (checkbox at far left with confusing distance to the label,
          // checkbox overlapping the label text mid-row, label text
          // invisible). Buttons can't disappear, can't be overlaid by
          // their text content, can't have their click hijacked by a
          // parent label association, and render the same way across
          // every theme.
          return (
            <div key={cat.id} className="wf-tool-cat">
              <div className="wf-tool-cat-head">
                <button
                  type="button"
                  className="wf-tool-cat-disclose"
                  aria-expanded={!isCollapsed}
                  aria-controls={`wf-tool-cat-body-${cat.id}`}
                  onClick={() => toggleCollapse(cat.id, ruleDefault)}
                  title={cat.description}
                >
                  <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>{" "}
                  {cat.label}
                </button>
                <button
                  type="button"
                  className="wf-tool-cat-master"
                  aria-pressed={master === "all"}
                  data-state={master}
                  onClick={() =>
                    onChange(applyMasterToggle(selected, cat.tools))
                  }
                  title={
                    master === "all"
                      ? `Deselect all ${cat.label} tools`
                      : `Select all ${cat.label} tools`
                  }
                >
                  <span className="wf-tool-cat-count">
                    {hits} / {cat.tools.length}
                  </span>
                  <span className="wf-tool-cat-master-glyph" aria-hidden="true">
                    {master === "all" ? "☑" : master === "some" ? "◐" : "☐"}
                  </span>
                </button>
              </div>
              {!isCollapsed && (
                <div
                  id={`wf-tool-cat-body-${cat.id}`}
                  className="wf-tool-cat-body"
                >
                  {cat.tools.map((tool) => {
                    const isOn = selected.includes(tool);
                    return (
                      <button
                        key={tool}
                        type="button"
                        className="wf-tool-item"
                        data-on={isOn}
                        aria-pressed={isOn}
                        onClick={() => onToggleOne(tool)}
                      >
                        <span className="wf-tool-item-name">{tool}</span>
                        <span
                          className="wf-tool-item-check"
                          aria-hidden="true"
                        >
                          {isOn ? "☑" : "☐"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="wf-field-hint">
        No tools selected = role default tools. Click a category checkbox
        to toggle every tool in that group at once.
      </p>
    </div>
  );
}
