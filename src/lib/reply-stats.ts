import type { ReplyUsage } from "./mlx-client";

/*
 * Per-reply performance stats (inference perf wave D, 2026-06-11). Volatile,
 * session-only: keyed by persisted message id once the assistant turn lands.
 * MessageRow renders the footer from here; the durable per-model ledger is
 * the Rust `model_perf_samples` table (recorded at capture time).
 */

export interface ReplyStat {
  /** Milliseconds from request start to first streamed delta. */
  ttftMs: number;
  /** Decode speed. Exact when server timings were reported. */
  tokPerSec: number | null;
  completionTokens: number | null;
  /** True when the server reported a >1s model load for this request. */
  coldLoad: boolean;
  model: string;
}

const stats = new Map<number, ReplyStat>();
const listeners = new Set<() => void>();

export function setReplyStat(messageId: number, stat: ReplyStat): void {
  stats.set(messageId, stat);
  // Bound the session map — old entries have scrolled away anyway.
  if (stats.size > 500) {
    const first = stats.keys().next().value;
    if (first !== undefined) stats.delete(first);
  }
  for (const l of listeners) l();
}

export function getReplyStat(
  messageId: number | undefined,
): ReplyStat | undefined {
  return messageId == null ? undefined : stats.get(messageId);
}

export function subscribeReplyStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Build a stat from stream timestamps + (optional) server-reported usage. */
export function buildReplyStat(
  model: string,
  t0: number,
  firstDeltaAt: number | null,
  doneAt: number,
  usage: ReplyUsage | undefined,
  fallbackChars: number,
): ReplyStat {
  const ttftMs = Math.max(0, Math.round((firstDeltaAt ?? doneAt) - t0));
  let tokPerSec: number | null = null;
  let completionTokens: number | null = null;
  if (
    usage?.completion_tokens != null &&
    usage.eval_duration_ms &&
    usage.eval_duration_ms > 0
  ) {
    // Exact: tokens over PURE decode time (prefill/load excluded).
    completionTokens = usage.completion_tokens;
    tokPerSec = (usage.completion_tokens / usage.eval_duration_ms) * 1000;
  } else if (firstDeltaAt != null && doneAt > firstDeltaAt) {
    // Estimate: chars/4 over wall decode window.
    completionTokens = Math.round(fallbackChars / 4);
    tokPerSec = (completionTokens / (doneAt - firstDeltaAt)) * 1000;
  }
  return {
    ttftMs,
    tokPerSec: tokPerSec != null ? Math.round(tokPerSec * 10) / 10 : null,
    completionTokens,
    coldLoad: (usage?.load_duration_ms ?? 0) > 1000,
    model,
  };
}
