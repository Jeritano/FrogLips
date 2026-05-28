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
    pattern: /(?:^|[^a-z0-9])(?:128k|llama-?4|llama-?3\.[123]|llama3[._-]?[123])(?![a-z0-9])/i,
    tokens: 128_000,
  },
  // Qwen2.5 / Qwen3 / Mistral-Nemo / Command-R all 32k+ class.
  {
    pattern: /(?:^|[^a-z0-9])(?:qwen2\.5|qwen3|mistral-?nemo|command-?r)(?![a-z0-9])/i,
    tokens: 32_768,
  },
  { pattern: /(?:^|[^a-z0-9])(?:mistral|mixtral|mistral-?small)(?![a-z0-9])/i, tokens: 32_768 },
  // Gemma 2/3 → 8k. Phi-3.5/4 → 16k (Phi-3 base stays 4k below).
  { pattern: /(?:^|[^a-z0-9])(?:phi-?3\.5|phi-?4)(?![a-z0-9])/i, tokens: 16_384 },
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
 * Note: `content` is mutated in place on the streaming assistant msg
 * (`streamingMsg.content += delta`) — that same Message ref keeps its
 * cached estimate stale. The runner re-creates a fresh Message before
 * each `applyContextBudget` call only for the streaming bubble; the
 * other messages don't mutate in place so this is correct in practice.
 * Callers that violate that contract should use `invalidateMessageTokens`
 * below.
 */
const MESSAGE_TOKEN_CACHE = new WeakMap<Message, number>();

/** Drop a Message's cached token estimate. Call after mutating
 *  `content` or `tool_calls` in place. */
export function invalidateMessageTokens(m: Message): void {
  MESSAGE_TOKEN_CACHE.delete(m);
}

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
function summarizeCollapsedTurns(turns: Message[], conversationId: number): Message {
  const lines: string[] = [];
  for (const m of turns) {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
    const text = (m.content ?? "").replace(/\s+/g, " ").trim();
    const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const names = m.tool_calls.map((t) => t.function?.name ?? "?").join(", ");
      lines.push(`${role}: (called tools: ${names})${snippet ? ` ${snippet}` : ""}`);
    } else if (m.role === "tool") {
      lines.push(`Tool result: ${snippet}`);
    } else if (snippet) {
      lines.push(`${role}: ${snippet}`);
    }
  }
  return {
    conversation_id: conversationId,
    role: "system",
    content:
      `[Conversation summary — heuristic digest of ${turns.length} earlier ` +
      `message(s), NOT model-generated. Earlier detail was elided to fit the ` +
      `context window.]\n` +
      lines.join("\n"),
  };
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
  const contextTokens =
    opts.contextTokens ?? modelContextTokens(opts.model);
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
  for (let i = 1; i < working.length; i++) {
    if (estimateMessagesTokens(working) <= budget) break;
    const m = working[i];
    if (m.role !== "tool") continue;
    const body = m.content ?? "";
    if (body.length <= headBytes) continue;
    working[i] = { ...m, content: truncateToolBody(body, headBytes) };
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
    for (let collapseCount = 0; collapseCount < rest.length - 1; collapseCount++) {
      const collapsedSlice = rest.slice(0, collapseCount + 1);
      const summary = summarizeCollapsedTurns(collapsedSlice, convId);
      const summaryCost = estimateOneMessage(summary);
      const keptSum = totalRest - prefix[collapseCount + 1];
      const candidateCost = headCost + summaryCost + keptSum;
      if (candidateCost <= budget) {
        working = [head, summary, ...rest.slice(collapseCount + 1)];
        turnsCollapsed = collapsedSlice.length;
        break;
      }
    }
    // If even collapsing all-but-one didn't fit, take the maximal collapse.
    if (turnsCollapsed === 0 && rest.length > 1) {
      const collapsed = rest.slice(0, rest.length - 1);
      const kept = rest.slice(rest.length - 1);
      working = [head, summarizeCollapsedTurns(collapsed, convId), ...kept];
      turnsCollapsed = collapsed.length;
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
