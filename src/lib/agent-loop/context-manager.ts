/* ── Agent-loop context-window manager ────────────────────────────────────
 *
 * `runAgentLoop` re-sends the WHOLE message array on every iteration (up to
 * 40). Tool results are verbatim — `read_file` returns up to 64 KB. On a
 * small-context local model the backend silently evicts from the HEAD of the
 * prompt, dropping the system message (tool definitions + safety rules), so
 * the agent forgets its tools mid-run.
 *
 * This module budgets a COPY of the message array before each send:
 *   1. Truncate large `tool`-result bodies, leaving a re-read marker.
 *   2. If still over budget, collapse the oldest user/assistant turn pairs
 *      into a single synthetic summary system message.
 * The system prompt (first message) is NEVER dropped or truncated.
 *
 * Token estimation is a `chars / 4` heuristic — fast, model-agnostic, and
 * good enough for a budget gate (English averages ~4 chars/token; code runs
 * a little denser, so this slightly under-counts and we stay conservative).
 */

import type { Message } from "../../types";

/** Conservative default context window when the model is unknown. */
export const DEFAULT_CONTEXT_TOKENS = 8192;

/**
 * Per-model context-window overrides, keyed by a lowercase substring of the
 * model id. First match wins. Keep this list small — a miss just falls back
 * to {@link DEFAULT_CONTEXT_TOKENS}, which is safe (over-truncation is cheap).
 */
// Patterns are anchored with word-boundary-ish guards so a generic substring
// like "128k" doesn't blindly match e.g. `gemma3-128k-finetuned-2b` if that
// model id really only has an 8k effective window — the user can still hit
// over-truncation, but never under-truncation that crashes the request. Each
// pattern requires either a leading boundary (start/non-word) AND a trailing
// boundary, or a known prefix anchor.
const CONTEXT_OVERRIDES: Array<{ pattern: RegExp; tokens: number }> = [
  // Order matters — first match wins, so explicit "256k"/"1m" markers
  // and the largest-window families sit above the broad fallbacks.
  // (Audit MED 2026-05-28: this heuristic only fires when the backend
  // doesn't report an authoritative window — Ollama's /api/show does;
  // MLX + native don't yet. Broadened so common modern families land
  // closer to their real window instead of the 8k default.)
  { pattern: /(?:^|[^a-z0-9])(?:1m|1000k)(?![a-z0-9])/i, tokens: 1_000_000 },
  { pattern: /(?:^|[^a-z0-9])256k(?![a-z0-9])/i, tokens: 256_000 },
  // Llama 4 (Scout/Maverick) ship very large windows; treat the family
  // as 128k for a safe budget floor even though Scout advertises more.
  {
    pattern:
      /(?:^|[^a-z0-9])(?:128k|llama-?4|llama-?3\.[123]|llama3[._-]?[123])(?![a-z0-9])/i,
    tokens: 128_000,
  },
  // Hermes 3 / 4 are Llama-3.1-based → 128k window (Ollama /api/show still wins
  // when present; this is the fallback for MLX/native/cloud-tag lookups).
  { pattern: /(?:^|[^a-z0-9])hermes(?![a-z0-9])/i, tokens: 128_000 },
  // Qwen2.5 / Qwen3 / Mistral-Nemo / Command-R all 32k+ class.
  {
    pattern:
      /(?:^|[^a-z0-9])(?:qwen2\.5|qwen3|mistral-?nemo|command-?r)(?![a-z0-9])/i,
    tokens: 32_768,
  },
  {
    pattern: /(?:^|[^a-z0-9])(?:mistral|mixtral|mistral-?small)(?![a-z0-9])/i,
    tokens: 32_768,
  },
  // Gemma 2/3 → 8k. Phi-3.5/4 → 16k (Phi-3 base stays 4k below).
  {
    pattern: /(?:^|[^a-z0-9])(?:phi-?3\.5|phi-?4)(?![a-z0-9])/i,
    tokens: 16_384,
  },
  // Gemma 4 ships a large (~128k) window; gemma 2/3 stay 8k. Keep gemma4
  // ABOVE the gemma-2/3 rule so it wins. (Ollama /api/show is still the
  // authoritative source when available — this is the fallback for the
  // agent-loop budgeter, cloud tags, or a failed lookup.)
  { pattern: /(?:^|[^a-z0-9])gemma-?4(?![a-z0-9])/i, tokens: 128_000 },
  { pattern: /(?:^|[^a-z0-9])gemma-?[23](?![a-z0-9])/i, tokens: 8_192 },
  { pattern: /(?:^|[^a-z0-9])phi-?3(?![a-z0-9])/i, tokens: 4_096 },
  {
    pattern: /(?:^|[^a-z0-9])(?:tinyllama|qwen2[._-]?0\.5b)(?![a-z0-9])/i,
    tokens: 2_048,
  },
];

/** Resolve a model id to its context-window size in tokens. */
export function modelContextTokens(modelId: string | null | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_TOKENS;
  for (const { pattern, tokens } of CONTEXT_OVERRIDES) {
    if (pattern.test(modelId)) return tokens;
  }
  return DEFAULT_CONTEXT_TOKENS;
}

/** Estimate token count of a string (chars / 4 heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Per-Message token estimate cache. `applyContextBudget` calls
 * `estimateMessagesTokens` 2-4× per turn, and each call re-scans every
 * message in the array including the JSON.stringify of tool_calls.
 * Maturity review H4 (2026-05-27): a 30-turn run with 30 messages was
 * doing ~3600 redundant char-scans per loop iteration on the runner's
 * hot path. WeakMap keyed by Message ref means the cache invalidates
 * automatically when the runner replaces a message reference (e.g.
 * after a tool-result splice) and an updated `content` produces a new
 * key entry on next access.
 *
 * Note: correctness rests on messages never being mutated in place once
 * estimated (the runner replaces, never mutates, since the streaming
 * placeholder was removed in the 2026-06-09 perf pass), so the cache never
 * needs explicit invalidation — a mutated message is a different object.
 */
const MESSAGE_TOKEN_CACHE = new WeakMap<Message, number>();

function estimateOneMessage(m: Message): number {
  const cached = MESSAGE_TOKEN_CACHE.get(m);
  if (cached !== undefined) return cached;
  let total = estimateTokens(m.content);
  if (m.tool_calls?.length) {
    total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  total += 4;
  MESSAGE_TOKEN_CACHE.set(m, total);
  return total;
}

/** Estimate total tokens of a message array, including per-message overhead. */
export function estimateMessagesTokens(msgs: Message[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateOneMessage(m);
  }
  return total;
}

export interface BudgetOptions {
  /** Model id — used to resolve the context window. */
  model?: string | null;
  /** Explicit context-window size; overrides model lookup when provided. */
  contextTokens?: number;
  /**
   * Fraction of the context window reserved for the model's reply. The
   * budget the prompt must fit inside is `contextTokens * (1 - reserve)`.
   */
  replyReserveFraction?: number;
  /** Bytes of a truncated tool result to keep from the head. */
  toolResultHeadBytes?: number;
}

export interface BudgetResult {
  /** The budgeted COPY safe to send. Never mutates the input array. */
  messages: Message[];
  /** True when any truncation or collapse was applied. */
  trimmed: boolean;
  /** Estimated tokens before budgeting. */
  estimatedBefore: number;
  /** Estimated tokens after budgeting. */
  estimatedAfter: number;
  /** Token budget the prompt was fitted into. */
  budget: number;
  /** Number of tool-result bodies truncated. */
  toolResultsTruncated: number;
  /** Number of old turns collapsed into the synthetic summary. */
  turnsCollapsed: number;
}

const DEFAULT_REPLY_RESERVE = 0.25;
const DEFAULT_TOOL_HEAD_BYTES = 2_048;

/** Truncate a tool-result body to its head, appending a re-read marker. */
function truncateToolBody(body: string, headBytes: number): string {
  if (body.length <= headBytes) return body;
  const elided = body.length - headBytes;
  return (
    body.slice(0, headBytes) +
    `\n\n[… elided ${elided} bytes — re-read the file/url for more]`
  );
}

/**
 * Build a synthetic, NON-model-generated summary of a run of collapsed turns.
 * It is a heuristic textual digest only — flagged as such so a reader (human
 * or model) knows it is lossy and not an actual assistant statement.
 */
function digestLine(m: Message): string | null {
  const role =
    m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
  const text = (m.content ?? "").replace(/\s+/g, " ").trim();
  const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
  if (m.role === "assistant" && m.tool_calls?.length) {
    const names = m.tool_calls.map((t) => t.function?.name ?? "?").join(", ");
    return `${role}: (called tools: ${names})${snippet ? ` ${snippet}` : ""}`;
  }
  if (m.role === "tool") return `Tool result: ${snippet}`;
  if (snippet) return `${role}: ${snippet}`;
  return null;
}

function summaryHeader(count: number): string {
  return (
    `[Conversation summary — heuristic digest of ${count} earlier ` +
    `message(s), NOT model-generated. Earlier detail was elided to fit the ` +
    `context window.]\n`
  );
}

function summarizeCollapsedTurns(
  turns: Message[],
  conversationId: number,
): Message {
  const lines: string[] = [];
  for (const m of turns) {
    const line = digestLine(m);
    if (line != null) lines.push(line);
  }
  return {
    conversation_id: conversationId,
    role: "system",
    content: summaryHeader(turns.length) + lines.join("\n"),
  };
}

/**
 * Snap a desired kept-suffix start index to a turn boundary so the collapse
 * never splits an assistant `tool_calls` message from its `tool` results.
 *
 * The OpenAI tool-calling contract requires every assistant `tool_calls`
 * message to be immediately followed by a `role:"tool"` message per
 * `tool_call_id`. If the collapse boundary lands between them, the sent array
 * begins with an orphan `tool` whose `tool_call_id` references a message that
 * was folded into the summary — and Ollama / MLX / the cloud routes reject the
 * whole request with a 400 mid-run (HIGH, 2026-05-30). This precisely defeats
 * the small-context-plus-long-tool-run scenario this module exists for.
 *
 * Rule: a valid start is any non-`tool` message. If `desired` lands on a
 * `tool` message we move FORWARD, folding the orphaned results into the
 * summary. If moving forward would consume everything (a degenerate trailing
 * run of tool messages), we move BACKWARD to include the assistant call that
 * owns them, so the kept tail is a complete group. May return 0, meaning the
 * whole tail is one indivisible group and no safe collapse exists.
 */
function snapToTurnBoundary(rest: Message[], desired: number): number {
  let start = desired;
  while (start < rest.length && rest[start]?.role === "tool") start++;
  if (start < rest.length) return start;
  // Everything from `desired` onward was tool results. Back up to the owning
  // assistant `tool_calls` message so the kept group stays intact.
  start = desired;
  while (start > 0 && rest[start - 1]?.role === "tool") start--;
  if (start > 0 && rest[start - 1]?.role === "assistant") start--;
  return start;
}

/**
 * Fit `msgs` inside the model's context window, returning a COPY safe to send.
 *
 * The first message (system prompt) is treated as immutable and always kept
 * intact. Strategy, in order:
 *   1. If under budget — return a shallow copy unchanged.
 *   2. Truncate `tool`-result bodies (oldest first) to their head.
 *   3. Collapse the oldest non-system turns into one synthetic summary
 *      system message inserted right after the real system prompt.
 *
 * The caller's persisted/displayed history is never mutated.
 */
export function applyContextBudget(
  msgs: Message[],
  opts: BudgetOptions = {},
): BudgetResult {
  const contextTokens = opts.contextTokens ?? modelContextTokens(opts.model);
  const reserve = opts.replyReserveFraction ?? DEFAULT_REPLY_RESERVE;
  const headBytes = opts.toolResultHeadBytes ?? DEFAULT_TOOL_HEAD_BYTES;
  const budget = Math.max(256, Math.floor(contextTokens * (1 - reserve)));

  const estimatedBefore = estimateMessagesTokens(msgs);

  // Work on a shallow copy of references; clone individual messages only
  // when we actually mutate their body.
  let working: Message[] = msgs.slice();
  let toolResultsTruncated = 0;
  let turnsCollapsed = 0;

  if (estimatedBefore <= budget) {
    return {
      messages: working,
      trimmed: false,
      estimatedBefore,
      estimatedAfter: estimatedBefore,
      budget,
      toolResultsTruncated: 0,
      turnsCollapsed: 0,
    };
  }

  // ── Pass 1: truncate large tool-result bodies, oldest first. ──
  // The first message is never touched even if (defensively) it were a tool.
  //
  // Perf review (low, 2026-06-13): the under-budget check formerly re-ran
  // estimateMessagesTokens(working) — a full O(n) scan — at the top of every
  // iteration, making Pass 1 O(n²) on over-budget turns. Track a running scalar
  // instead, adjusting it by the delta on each truncation (the same prefix-sum
  // technique Pass 2 uses below). The truncated message is a fresh object that
  // misses the WeakMap cache, so estimateOneMessage recomputes its cost once —
  // exactly the work we need — and the whole pass is now O(n).
  let runningTotal = estimatedBefore;
  for (let i = 1; i < working.length; i++) {
    if (runningTotal <= budget) break;
    const m = working[i];
    if (m.role !== "tool") continue;
    const body = m.content ?? "";
    if (body.length <= headBytes) continue;
    const before = estimateOneMessage(m);
    const next = { ...m, content: truncateToolBody(body, headBytes) };
    working[i] = next;
    runningTotal += estimateOneMessage(next) - before;
    toolResultsTruncated++;
  }

  // ── Pass 2: collapse oldest non-system turns into a summary. ──
  // Audit L-A3 (2026-05-28): previous implementation was O(n²) — each
  // collapseCount iteration rebuilt the candidate array and called
  // `estimateMessagesTokens` over the full N messages. On a 40-turn run
  // with 80 messages that's ~3200 char-scans per budget pass on the hot
  // path. Switched to prefix sums computed once (O(n)) and an O(1)
  // candidate cost = head + summary(collapsed) + kept_suffix_sum. Total
  // pass cost is now O(n × cost_of_summarizeCollapsedTurns), and the
  // summary itself walks at most `collapseCount` messages which we already
  // accept as the work we're doing.
  if (estimateMessagesTokens(working) > budget && working.length > 1) {
    const head = working[0]; // system prompt — immutable.
    const rest = working.slice(1);
    const convId = head.conversation_id;

    // Per-message costs and prefix sums. `prefix[i]` = sum of rest[0..i-1].
    const restCosts: number[] = new Array(rest.length);
    const prefix: number[] = new Array(rest.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = estimateOneMessage(rest[i]);
      restCosts[i] = c;
      prefix[i + 1] = prefix[i] + c;
    }
    const headCost = estimateOneMessage(head);
    const totalRest = prefix[rest.length];

    // Collapse from the front until we fit or only the most recent turn
    // remains. We always keep at least the final message so the model has
    // the live user request to act on.
    //
    // Perf review M3 (2026-06-09): the previous loop materialized the full
    // summary Message per candidate — `summarizeCollapsedTurns(rest.slice(0,
    // k+1))` re-digested an ever-growing prefix, O(k²) string work per
    // budget pass (measured 4-40ms per agent iteration at 50-140 messages,
    // recurring every iteration once over budget). Each message's digest
    // line is independent of the others, so build lines incrementally and
    // track the joined length; the summary cost mirrors estimateOneMessage
    // for a system message: ceil(contentLen / 4) + 4. The actual summary
    // string is only built once, on the success branch.
    const digestLines: string[] = [];
    let digestLen = 0; // length of lines.join("\n")
    for (
      let collapseCount = 0;
      collapseCount < rest.length - 1;
      collapseCount++
    ) {
      const line = digestLine(rest[collapseCount]);
      if (line != null) {
        digestLen += (digestLines.length > 0 ? 1 : 0) + line.length;
        digestLines.push(line);
      }
      const summaryCost =
        Math.ceil((summaryHeader(collapseCount + 1).length + digestLen) / 4) +
        4;
      const keptSum = totalRest - prefix[collapseCount + 1];
      const candidateCost = headCost + summaryCost + keptSum;
      if (candidateCost <= budget) {
        // Snap the boundary so we never orphan a tool result (HIGH,
        // 2026-05-30). Folding extra orphaned tool messages into the summary
        // only shrinks the kept suffix, so the candidate still fits.
        const keptStart = snapToTurnBoundary(rest, collapseCount + 1);
        if (keptStart < 1) break; // whole tail is one group — can't collapse safely
        working = [
          head,
          summarizeCollapsedTurns(rest.slice(0, keptStart), convId),
          ...rest.slice(keptStart),
        ];
        turnsCollapsed = keptStart;
        break;
      }
    }
    // If even collapsing all-but-one didn't fit, take the maximal collapse —
    // still snapped to a turn boundary so the final group stays paired.
    if (turnsCollapsed === 0 && rest.length > 1) {
      const keptStart = snapToTurnBoundary(rest, rest.length - 1);
      if (keptStart >= 1) {
        working = [
          head,
          summarizeCollapsedTurns(rest.slice(0, keptStart), convId),
          ...rest.slice(keptStart),
        ];
        turnsCollapsed = keptStart;
      }
    }
  }

  return {
    messages: working,
    trimmed: true,
    estimatedBefore,
    estimatedAfter: estimateMessagesTokens(working),
    budget,
    toolResultsTruncated,
    turnsCollapsed,
  };
}
