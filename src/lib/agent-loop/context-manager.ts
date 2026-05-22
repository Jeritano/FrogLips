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
const CONTEXT_OVERRIDES: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /128k|llama-?3\.[12]|llama3[._-]?[12]/i, tokens: 128_000 },
  { pattern: /qwen2\.5|qwen3/i, tokens: 32_768 },
  { pattern: /mistral|mixtral/i, tokens: 32_768 },
  { pattern: /gemma-?[23]/i, tokens: 8_192 },
  { pattern: /phi-?3/i, tokens: 4_096 },
  { pattern: /tinyllama|qwen2[._-]?0\.5b/i, tokens: 2_048 },
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

/** Estimate total tokens of a message array, including per-message overhead. */
export function estimateMessagesTokens(msgs: Message[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateTokens(m.content);
    // Tool-call payloads ride alongside `content` on the wire.
    if (m.tool_calls?.length) {
      total += estimateTokens(JSON.stringify(m.tool_calls));
    }
    // ~4 tokens of role/delimiter framing per message.
    total += 4;
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
  if (estimateMessagesTokens(working) > budget && working.length > 1) {
    const head = working[0]; // system prompt — immutable.
    const rest = working.slice(1);
    const convId = head.conversation_id;

    // Collapse from the front until we fit or only the most recent turn
    // remains. We always keep at least the final message so the model has
    // the live user request to act on.
    let collapseCount = 0;
    while (collapseCount < rest.length - 1) {
      const collapsed = rest.slice(0, collapseCount + 1);
      const kept = rest.slice(collapseCount + 1);
      const summary = summarizeCollapsedTurns(collapsed, convId);
      const candidate = [head, summary, ...kept];
      if (estimateMessagesTokens(candidate) <= budget) {
        working = candidate;
        turnsCollapsed = collapsed.length;
        break;
      }
      collapseCount++;
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
