/**
 * Workflow orchestration node handlers.
 *
 * A workflow card whose `nodeType` is anything other than `"agent"` is an
 * ORCHESTRATOR: instead of one `runAgentLoop` pass it fans out, loops, votes,
 * or escalates a set of sub-runs. Every sub-run still goes through the same
 * `runAgentLoop` (so tools / MCP / approval gates / streaming all work), which
 * means these handlers compose on top of the existing engine with zero changes
 * to the backend layer.
 *
 * Backend note: `runAgentLoop` only supports the `ollama | mlx | native`
 * backends for tool-calling. The "cloud tier" inside a flow is therefore an
 * Ollama `:cloud` model id (e.g. `kimi-k2.6:cloud`) on the `ollama` backend,
 * NOT an OpenRouter/custom backend. Backend overrides below are coerced to the
 * three supported kinds; an unsupported string falls back to the card backend.
 *
 * Confidence: no logprobs are exposed by any backend, so "confidence" for the
 * critic/cascade nodes is a separate critic-model scoring pass (`SCORE: <n>`),
 * not a token-probability signal.
 */

import type { Message, WorkflowCard } from "../../types";
import type { AgentBackend, AgentRunOptions } from "../agent-loop/types";
import { runAgentLoop } from "../agent-loop";
import type { loadAllPresets } from "../agent-presets";
import { clearAll as scratchpadClear, snapshot as scratchpadSnapshot } from "./scratchpad";

type Presets = ReturnType<typeof loadAllPresets>;

/** Context handed to every node handler. `base` is the `AgentRunOptions` the
 *  runner already built for this card via `buildCardOptions`. */
export interface NodeRunContext {
  card: WorkflowCard;
  base: AgentRunOptions;
  presets: Presets;
  signal: AbortSignal;
  /** Stream progress / status text to the card's live output (onCardOutput). */
  emit: (text: string) => void;
}

/** True when a card needs the orchestrator dispatch rather than a plain agent pass. */
export function isOrchestratorNode(card: WorkflowCard): boolean {
  return !!card.nodeType && card.nodeType !== "agent";
}

/* ── shared helpers ─────────────────────────────────────────────────── */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The card's task = its last user message (date-substituted by the runner). */
function taskText(base: AgentRunOptions): string {
  const u = [...base.messages].reverse().find((m) => m.role === "user");
  return u?.content ?? "";
}

/** The leading system messages (handoff envelope etc.) preserved across sub-runs. */
function systemMessages(base: AgentRunOptions): Message[] {
  return base.messages.filter((m) => m.role === "system");
}

/** Only `ollama | mlx | native` are valid agent-loop backends. */
function coerceBackend(s?: string | null): AgentBackend | undefined {
  return s === "ollama" || s === "mlx" || s === "native" ? s : undefined;
}

/** Extract a 0..100 score from a critic reply (`SCORE: 87` or `87/100`). */
function parseScore(text: string): number | null {
  const m =
    text.match(/SCORE\s*[:=]?\s*(\d{1,3})/i) ?? text.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/** Pick a 1-based route number out of a classifier reply; clamps into range. */
function parseRouteIndex(text: string, n: number): number {
  const m = text.match(/\d+/);
  if (!m) return 0;
  const i = parseInt(m[0], 10) - 1;
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(i, n - 1); // clamp an out-of-range high index to the last route
}

/** Normalize a free-text answer for vote comparison (whitespace/case/terminal punctuation). */
function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

/** Plurality vote over samples: returns the modal answer verbatim when at
 *  least two samples agree, else null (→ caller falls back to synthesis). */
function majorityVote(samples: string[]): { answer: string; agree: number } | null {
  const counts = new Map<string, { count: number; rep: string }>();
  for (const s of samples) {
    if (!s || s.startsWith("[sample ")) continue; // skip failed proposers
    const key = normalizeAnswer(s);
    if (!key) continue;
    const e = counts.get(key);
    if (e) e.count++;
    else counts.set(key, { count: 1, rep: s.trim() });
  }
  let best: { count: number; rep: string } | null = null;
  for (const e of counts.values()) if (!best || e.count > best.count) best = e;
  return best && best.count >= 2 ? { answer: best.rep, agree: best.count } : null;
}

interface SubOpts {
  /** Replace the user message (system/handoff messages are preserved). Omit to reuse the card prompt verbatim. */
  userContent?: string;
  model?: string | null;
  backend?: AgentBackend;
  systemPromptOverride?: string;
  toolAllowlist?: string[];
  /** Cap generated tokens for this sub-run (budget node). */
  maxTokens?: number | null;
  /** Stream this sub-run's deltas to the card UI. Off for hidden sub-runs (proposers/critics). */
  stream?: boolean;
  /** Override the abort signal (budget node uses a child controller). */
  signal?: AbortSignal;
  /** Custom delta sink (defaults to ctx.emit when streaming). */
  onDelta?: (t: string) => void;
}

/** Run one sub-agent through the real agent loop with per-call overrides. */
async function runSub(ctx: NodeRunContext, o: SubOpts): Promise<string> {
  const messages: Message[] =
    o.userContent != null
      ? [...systemMessages(ctx.base), { conversation_id: 0, role: "user", content: o.userContent }]
      : ctx.base.messages;
  const params =
    o.maxTokens != null
      ? { ...(ctx.base.params ?? {}), max_tokens: o.maxTokens }
      : ctx.base.params;
  const opts: AgentRunOptions = {
    ...ctx.base,
    model: o.model && o.model.length > 0 ? o.model : ctx.base.model,
    backend: o.backend ?? ctx.base.backend,
    messages,
    params,
    systemPromptOverride: o.systemPromptOverride ?? ctx.base.systemPromptOverride,
    toolAllowlist: o.toolAllowlist ?? ctx.base.toolAllowlist,
    signal: o.signal ?? ctx.signal,
    onAssistantDelta: o.stream ? (o.onDelta ?? ctx.emit) : () => {},
    onUpdate: () => {},
    onStatusChange: () => {},
  };
  return (await runAgentLoop(opts)) ?? "";
}

/* ── node handlers ──────────────────────────────────────────────────── */

const DEFAULT_SYNTH =
  "You are an expert aggregator. Read the independent proposals below and produce the single best, correct, and complete answer. Resolve disagreements by reasoning about which is right — do not merely concatenate them.";

/** Mixture-of-Agents: N proposers in parallel → one synthesis pass. */
async function runMoa(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const n = cfg.members ?? 3;
  const task = taskText(ctx.base);
  ctx.emit(`Mixture-of-Agents — ${n} proposers running in parallel…\n`);
  const proposals = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runSub(ctx, { stream: false }).catch((e) => `[proposer ${i + 1} failed: ${errMsg(e)}]`),
    ),
  );
  if (ctx.signal.aborted) return proposals.find(Boolean) ?? "";
  ctx.emit(`\nSynthesizing ${n} proposals…\n\n`);
  const block = proposals.map((p, i) => `### Proposal ${i + 1}\n${p}`).join("\n\n");
  const instr = cfg.synthPrompt ?? DEFAULT_SYNTH;
  const userContent = `${instr}\n\n## Task\n${task}\n\n## Proposals\n${block}\n\n## Your single best answer:`;
  return runSub(ctx, {
    userContent,
    model: cfg.synthModel,
    backend: coerceBackend(cfg.synthBackend),
    stream: true,
  });
}

/** Self-consistency: sample the same prompt N times, then vote or merge. */
async function runConsistency(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const n = cfg.members ?? 5;
  const mode = cfg.voteMode ?? "synth";
  const task = taskText(ctx.base);
  ctx.emit(`Self-consistency — ${n} samples…\n`);
  const samples = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runSub(ctx, { stream: false }).catch((e) => `[sample ${i + 1} failed: ${errMsg(e)}]`),
    ),
  );
  if (ctx.signal.aborted) return samples.find(Boolean) ?? "";
  // "vote" → a real tally: if ≥2 samples produce the same answer, return the
  // modal one verbatim (cheap, no extra LLM call). Only fall back to a synthesis
  // pass when there's no agreement.
  if (mode === "vote") {
    const winner = majorityVote(samples);
    if (winner) {
      ctx.emit(`Majority vote: ${winner.agree}/${n} agree.\n\n`);
      return winner.answer;
    }
    ctx.emit(`No majority — synthesizing instead.\n\n`);
  } else {
    ctx.emit(`Merging ${n} samples…\n\n`);
  }
  const block = samples.map((s, i) => `### Sample ${i + 1}\n${s}`).join("\n\n");
  const instr =
    mode === "vote"
      ? "Below are independent samples answering the SAME task. Determine the answer the MAJORITY of samples agree on and return that consensus answer (lightly cleaned up). If there is no clear majority, return the most defensible single answer."
      : cfg.synthPrompt ??
        "Merge these independent samples into the single most self-consistent answer, keeping only conclusions that most samples agree on.";
  const userContent = `${instr}\n\n## Task\n${task}\n\n## Samples\n${block}\n\n## Final answer:`;
  return runSub(ctx, {
    userContent,
    model: cfg.synthModel,
    backend: coerceBackend(cfg.synthBackend),
    stream: true,
  });
}

/** Critic loop: generate → critique (scored) → revise, until pass or maxIters. */
async function runCritic(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const maxIters = cfg.maxIters ?? 3;
  const threshold = cfg.passThreshold ?? 80;
  const task = taskText(ctx.base);
  ctx.emit(`Generating initial draft…\n`);
  let draft = await runSub(ctx, { stream: true });
  for (let i = 0; i < maxIters; i++) {
    if (ctx.signal.aborted) break;
    const criticInstr =
      cfg.criticPrompt ??
      "You are a rigorous critic. Score how well the candidate answer solves the task (0-100), then list specific, actionable flaws to fix. Begin your reply with exactly 'SCORE: <number>'.";
    const critique = await runSub(ctx, {
      userContent: `${criticInstr}\n\n## Task\n${task}\n\n## Candidate answer\n${draft}`,
      model: cfg.criticModel,
      backend: coerceBackend(cfg.criticBackend),
      stream: false,
    });
    const score = parseScore(critique);
    ctx.emit(`\nCritic iteration ${i + 1}: score ${score ?? "?"} / ${threshold} pass mark\n`);
    if (score != null && score >= threshold) break;
    if (i === maxIters - 1) break; // out of iterations — keep the best draft
    ctx.emit(`Revising…\n`);
    draft = await runSub(ctx, {
      userContent: `Revise your answer to fix the critique below. Output ONLY the improved answer.\n\n## Task\n${task}\n\n## Previous answer\n${draft}\n\n## Critique\n${critique}`,
      stream: true,
    });
  }
  return draft;
}

/** Cascade: cheap/local model first; escalate to a stronger model if it scores low. */
async function runCascade(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const threshold = cfg.passThreshold ?? 70;
  const task = taskText(ctx.base);
  ctx.emit(`Cascade — trying base model (${ctx.base.model})…\n`);
  const baseAns = await runSub(ctx, { stream: true });
  if (ctx.signal.aborted || !cfg.escalateModel) return baseAns;
  const scoreInstr =
    cfg.criticPrompt ??
    "Score 0-100 how well this answer solves the task. Reply with only 'SCORE: <number>' followed by one short reason.";
  const critique = await runSub(ctx, {
    userContent: `${scoreInstr}\n\n## Task\n${task}\n\n## Answer\n${baseAns}`,
    model: cfg.criticModel,
    backend: coerceBackend(cfg.criticBackend),
    stream: false,
  });
  const score = parseScore(critique);
  ctx.emit(`\nBase score ${score ?? "?"} / ${threshold} escalation mark\n`);
  if (score != null && score >= threshold) return baseAns;
  ctx.emit(`Escalating to ${cfg.escalateModel}…\n`);
  return runSub(ctx, {
    model: cfg.escalateModel,
    backend: coerceBackend(cfg.escalateBackend),
    stream: true,
  });
}

/** Router: classify the task → run the best-fit route (model/backend/preset). */
async function runRouter(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const routes = cfg.routes ?? [];
  const task = taskText(ctx.base);
  if (routes.length === 0) return runSub(ctx, { stream: true });
  const list = routes.map((r, i) => `${i + 1}. [${r.label}] ${r.when}`).join("\n");
  const decision = await runSub(ctx, {
    userContent: `You are a routing classifier. Choose the single best-fit route for the task. Reply with ONLY the route number.\n\n## Task\n${task}\n\n## Routes\n${list}\n\n## Best route number:`,
    model: cfg.routerModel,
    backend: coerceBackend(cfg.routerBackend),
    stream: false,
  });
  const chosen = routes[parseRouteIndex(decision, routes.length)] ?? routes[0];
  ctx.emit(`Routed → [${chosen.label}]\n`);
  const preset = chosen.preset ? ctx.presets.find((p) => p.id === chosen.preset) : undefined;
  return runSub(ctx, {
    model: chosen.model,
    backend: coerceBackend(chosen.backend),
    systemPromptOverride: preset?.systemPromptOverride,
    toolAllowlist: preset?.allowedTools,
    stream: true,
  });
}

/** Blackboard: operate on the shared run scratchpad (snapshot / summarize / clear). */
async function runBlackboard(ctx: NodeRunContext): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const op = cfg.blackboardOp ?? "snapshot";
  const snap = scratchpadSnapshot();
  const entries = snap?.entries ?? {};
  const json = JSON.stringify(entries, null, 2);
  if (op === "clear") {
    scratchpadClear();
    ctx.emit(`Blackboard cleared.\n`);
    return "Blackboard cleared.";
  }
  if (op === "snapshot") {
    const body = Object.keys(entries).length
      ? "```json\n" + json + "\n```"
      : "Blackboard is empty.";
    ctx.emit(`Blackboard snapshot:\n${body}\n`);
    return body;
  }
  // summarize
  const task = taskText(ctx.base);
  ctx.emit(`Summarizing shared blackboard…\n`);
  return runSub(ctx, {
    userContent: `Summarize the shared workflow state below into a concise briefing for the next agent.${task ? `\n\n## Focus\n${task}` : ""}\n\n## Shared state (JSON)\n${json}`,
    stream: true,
  });
}

/** Budget: run the base agent under a token and/or wall-clock ceiling. */
async function runBudget(ctx: NodeRunContext): Promise<string> {
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
  const limits = [
    cfg.maxMs != null ? `≤${Math.round(cfg.maxMs / 1000)}s` : null,
    cfg.maxTokens != null ? `≤${cfg.maxTokens} tok` : null,
  ].filter(Boolean);
  ctx.emit(`Budget run${limits.length ? ` (${limits.join(", ")})` : ""}…\n`);
  try {
    const out = await runSub(ctx, {
      stream: true,
      maxTokens: cfg.maxTokens ?? undefined,
      signal: child.signal,
      onDelta: (t) => {
        buf += t;
        ctx.emit(t);
      },
    });
    // A between-iteration abort makes runAgentLoop RETURN null (→ "") rather
    // than throw, so the time-budget branch must be handled here, not only in
    // catch. (A genuine user Stop also aborts child via onParentAbort, but
    // then ctx.signal.aborted is true → don't treat it as a budget hit.)
    if (timedOut && !ctx.signal.aborted) {
      if (onExceed === "best") {
        ctx.emit(`\nTime budget hit — returning best effort.\n`);
        return buf || "[budget exceeded before any output]";
      }
      throw new Error("Budget time ceiling exceeded.");
    }
    return out;
  } catch (e) {
    if (ctx.signal.aborted) throw e; // genuine user Stop — propagate
    if (timedOut) {
      if (onExceed === "best") {
        ctx.emit(`\nTime budget hit — returning best effort.\n`);
        return buf || "[budget exceeded before any output]";
      }
      throw new Error("Budget time ceiling exceeded.");
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

/** Dispatch a card to its orchestration handler. Call only when
 *  {@link isOrchestratorNode} is true; the `"agent"` default just runs once. */
export function runWorkflowNode(ctx: NodeRunContext): Promise<string> {
  switch (ctx.card.nodeType) {
    case "moa":
      return runMoa(ctx);
    case "consistency":
      return runConsistency(ctx);
    case "critic":
      return runCritic(ctx);
    case "cascade":
      return runCascade(ctx);
    case "router":
      return runRouter(ctx);
    case "blackboard":
      return runBlackboard(ctx);
    case "budget":
      return runBudget(ctx);
    default:
      return runSub(ctx, { stream: true });
  }
}
