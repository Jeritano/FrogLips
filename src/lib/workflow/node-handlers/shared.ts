/* ── Shared node-handler helpers ────────────────────────────────────────────
 *
 * Helpers used by more than one node handler. Moved VERBATIM out of the old
 * `nodes.ts` so behavior is byte-identical; `nodes.ts` re-exports the public
 * ones for back-compat. Keeping them here (rather than duplicated per handler)
 * means the two nodes that share a helper — e.g. `sampleTemperature`, used by
 * both moa and consistency — can't drift.
 */

import type { Message } from "../../../types";
import type { AgentBackend, AgentRunOptions } from "../../agent-loop/types";
import { runAgentLoop } from "../../agent-loop";
import type { NodeRunContext } from "./types";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The card's task = its last user message (date-substituted by the runner). */
export function taskText(base: AgentRunOptions): string {
  const u = [...base.messages].reverse().find((m) => m.role === "user");
  return u?.content ?? "";
}

/** The leading system messages (handoff envelope etc.) preserved across sub-runs. */
export function systemMessages(base: AgentRunOptions): Message[] {
  return base.messages.filter((m) => m.role === "system");
}

/** Agent-loop backends a flow sub-run may target. `ollama | mlx | native` are
 *  local/in-process; `custom | openrouter` are the OpenAI-compatible cloud
 *  backends (now first-class in the agent loop). An unsupported string falls
 *  back to the card backend (returns undefined). */
export function coerceBackend(s?: string | null): AgentBackend | undefined {
  return s === "ollama" ||
    s === "mlx" ||
    s === "native" ||
    s === "custom" ||
    s === "openrouter"
    ? s
    : undefined;
}

/** Extract a 0..100 score from a critic reply (`SCORE: 87` or `87/100`). */
export function parseScore(text: string): number | null {
  const m =
    text.match(/SCORE\s*[:=]?\s*(\d{1,3})/i) ??
    text.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/** Pick a 1-based route number out of a classifier reply; clamps into range.
 *  Bug fix: `text.match(/\d+/)` took the FIRST digit run anywhere, so reasoning
 *  preamble ("Looking at all 3 routes, route 2 fits best") poisoned the parse.
 *  Prefer the structured `ROUTE: <n>` token the prompt requests; otherwise take
 *  the LAST number (models end with their verdict), mirroring structuredKey's
 *  bottom-up scan so a terminal decision wins over incidental earlier digits. */
export function parseRouteIndex(text: string, n: number): number {
  const tagged = text.match(/ROUTE\s*[:=]?\s*(\d+)/i);
  const nums = tagged ? [tagged[1]] : text.match(/\d+/g);
  if (!nums || nums.length === 0) return 0;
  const i = parseInt(nums[nums.length - 1], 10) - 1;
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(i, n - 1); // clamp an out-of-range high index to the last route
}

/** Deterministic temperature spread for self-consistency members. Without it
 *  all N samples share one temperature → near-identical drafts and the vote has
 *  nothing to disagree on. Derive the value from the member INDEX (not
 *  Math.random — forbidden here) so the spread stays reproducible/testable:
 *  member 0 → SAMPLE_TEMP_MIN, last member → SAMPLE_TEMP_MAX, linear between.
 *  A single member collapses to the midpoint. */
const SAMPLE_TEMP_MIN = 0.5;
const SAMPLE_TEMP_MAX = 0.9;
export function sampleTemperature(i: number, n: number): number {
  if (n <= 1) return (SAMPLE_TEMP_MIN + SAMPLE_TEMP_MAX) / 2;
  const t =
    SAMPLE_TEMP_MIN + (SAMPLE_TEMP_MAX - SAMPLE_TEMP_MIN) * (i / (n - 1));
  return Math.round(t * 100) / 100; // tidy 2-decimal value
}

/** Normalize a free-text answer for vote comparison (whitespace/case/terminal punctuation). */
export function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

/** A structured final-verdict line like `FAULT: race condition` or
 *  `VERDICT: GUILTY` — an uppercase tag, a colon, then a value. When samples
 *  carry one, voting on the TAG VALUE (not the whole prose) finds agreement that
 *  exact-string equality of free text almost never would. Scans bottom-up so the
 *  card's terminal verdict wins over any earlier mention. */
export function structuredKey(s: string): string | null {
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*([A-Z][A-Z_]+)\s*:\s*(.+\S)\s*$/);
    if (m) return `${m[1].toUpperCase()}:${normalizeAnswer(m[2])}`;
  }
  return null;
}

/** Comparison key for the vote: prefer a structured final line (FAULT:/VERDICT:
 *  etc.), else the whole answer normalized. Cheap — no LLM call. */
export function voteKey(s: string): string {
  return structuredKey(s) ?? normalizeAnswer(s);
}

/** Plurality vote over samples: returns the modal answer verbatim when at
 *  least two samples agree, else null (→ caller falls back to synthesis).
 *  Agreement is keyed on {@link voteKey} so a shared structured verdict counts
 *  as a match even when the surrounding prose differs. */
export function majorityVote(
  samples: string[],
): { answer: string; agree: number } | null {
  const counts = new Map<string, { count: number; rep: string }>();
  for (const s of samples) {
    if (!s || s.startsWith("[sample ")) continue; // skip failed proposers
    const key = voteKey(s);
    if (!key) continue;
    const e = counts.get(key);
    if (e) e.count++;
    else counts.set(key, { count: 1, rep: s.trim() });
  }
  let best: { count: number; rep: string } | null = null;
  for (const e of counts.values()) if (!best || e.count > best.count) best = e;
  return best && best.count >= 2
    ? { answer: best.rep, agree: best.count }
    : null;
}

export interface SubOpts {
  /** Replace the user message (system/handoff messages are preserved). Omit to reuse the card prompt verbatim. */
  userContent?: string;
  model?: string | null;
  backend?: AgentBackend;
  systemPromptOverride?: string;
  toolAllowlist?: string[];
  /** Cap generated tokens for this sub-run (budget node). */
  maxTokens?: number | null;
  /** Override sampling temperature for this sub-run (self-consistency varies it per member). */
  temperature?: number;
  /** Stream this sub-run's deltas to the card UI. Off for hidden sub-runs (proposers/critics). */
  stream?: boolean;
  /** Override the abort signal (budget node uses a child controller). */
  signal?: AbortSignal;
  /** Custom delta sink (defaults to ctx.emit when streaming). */
  onDelta?: (t: string) => void;
}

/** Run one sub-agent through the real agent loop with per-call overrides. */
export async function runSub(ctx: NodeRunContext, o: SubOpts): Promise<string> {
  const messages: Message[] =
    o.userContent != null
      ? [
          ...systemMessages(ctx.base),
          { conversation_id: 0, role: "user", content: o.userContent },
        ]
      : ctx.base.messages;
  // A sub-run's own token cap never escapes a budget ceiling the wrapper placed
  // on base.params.max_tokens — keep the tighter of the two so the ceiling
  // reaches even sub-runs that override the cap (fix: overriding sub-runs used
  // to ignore the budget).
  const subMaxTokens =
    o.maxTokens != null
      ? Math.min(
          o.maxTokens,
          ctx.base.params?.max_tokens ?? Number.POSITIVE_INFINITY,
        )
      : null;
  const params =
    subMaxTokens != null || o.temperature != null
      ? {
          ...(ctx.base.params ?? {}),
          ...(subMaxTokens != null ? { max_tokens: subMaxTokens } : {}),
          ...(o.temperature != null ? { temperature: o.temperature } : {}),
        }
      : ctx.base.params;
  // Only honor an explicit sub-run model; otherwise inherit the card's.
  const subModel = o.model && o.model.length > 0 ? o.model : null;
  // A cloud backend (`custom`/`openrouter`) interprets the MODEL field as an
  // identifier (custom-backend registry id / catalogue model), NOT as a model
  // name. So a cloud `o.backend` with no paired sub-run model would pair itself
  // with ctx.base.model — a plain Ollama model name the cloud path can't
  // resolve. Before Phase 9 widened coerceBackend, an unsupported backend
  // string coerced to undefined and fell back to the card's working backend;
  // restore that safety net here by ignoring a cloud backend unless its own
  // model was supplied. (Reachable only via hand-edited/migrated graph_json —
  // the CardForm picker always sets model+backend together.)
  const isCloudBackend = o.backend === "custom" || o.backend === "openrouter";
  const subBackend =
    isCloudBackend && subModel == null ? ctx.base.backend : o.backend;
  const opts: AgentRunOptions = {
    ...ctx.base,
    model: subModel ?? ctx.base.model,
    backend: subBackend ?? ctx.base.backend,
    messages,
    params,
    systemPromptOverride:
      o.systemPromptOverride ?? ctx.base.systemPromptOverride,
    toolAllowlist: o.toolAllowlist ?? ctx.base.toolAllowlist,
    signal: o.signal ?? ctx.signal,
    onAssistantDelta: o.stream ? (o.onDelta ?? ctx.emit) : () => {},
    onUpdate: () => {},
    onStatusChange: () => {},
  };
  return (await runAgentLoop(opts)) ?? "";
}

/* ── budget-ceiling machinery (shared by the budget node + universal wrapper) ── */

/** What a budget body sees: the child abort signal it must thread into its
 *  sub-runs, and a buffering `emit` whose accumulation becomes the best-effort
 *  partial if the time ceiling fires. */
export interface BudgetInner {
  signal: AbortSignal;
  emit: (text: string) => void;
}

/**
 * Shared budget-ceiling machinery for the `budget` node handler and the
 * universal budget wrapper — one implementation so the two can't drift.
 * Arms ONE child abort controller (forwarded from the parent signal) and, when
 * `maxMs` is set, ONE wall-clock timer that aborts it. Runs `body`, then applies
 * the uniform `onExceed` policy:
 *   - "best": on a time-ceiling hit return the body's own result, else the text
 *     buffered through `inner.emit`, else a placeholder.
 *   - "stop": throw.
 * A genuine user Stop (parent `ctx.signal` aborted) propagates and is NEVER
 * treated as a budget hit. A between-iteration abort can make a sub-run RETURN
 * (its partial, or "") rather than throw, so the time-budget branch runs in both
 * the success and catch paths.
 */
export async function withBudgetCeiling(
  ctx: NodeRunContext,
  body: (inner: BudgetInner) => Promise<string>,
): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const onExceed = cfg.onExceed ?? "best";
  const child = new AbortController();
  const onParentAbort = () => child.abort();
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (cfg.maxMs != null) {
    timer = setTimeout(() => {
      timedOut = true;
      child.abort();
    }, cfg.maxMs);
  }
  let buf = "";
  const emit = (t: string) => {
    buf += t;
    ctx.emit(t);
  };
  const bestEffort = (out?: string): string => {
    ctx.emit(`\nTime budget hit — returning best effort.\n`);
    return out || buf || "[budget exceeded before any output]";
  };
  try {
    const out = await body({ signal: child.signal, emit });
    if (timedOut && !ctx.signal.aborted) {
      if (onExceed === "best") return bestEffort(out);
      throw new Error("Budget time ceiling exceeded.");
    }
    return out;
  } catch (e) {
    if (ctx.signal.aborted) throw e; // genuine user Stop — propagate
    if (timedOut) {
      if (onExceed === "best") return bestEffort();
      throw new Error("Budget time ceiling exceeded.");
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

/** Render the active limits for a budget status line. */
export function budgetLimits(
  cfg: NonNullable<import("../../../types").WorkflowCard["nodeConfig"]>,
): string[] {
  return [
    cfg.maxMs != null ? `≤${Math.round(cfg.maxMs / 1000)}s` : null,
    cfg.maxTokens != null ? `≤${cfg.maxTokens} tok` : null,
  ].filter((s): s is string => s != null);
}
