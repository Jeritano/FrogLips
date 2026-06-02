import { useEffect, useMemo, useState } from "react";
import type { Message, ServerStatus } from "../types";
import { estimateMessagesTokens } from "../lib/agent-loop/context-manager";
import {
  prefetchContextLength,
  resolveContextTokens,
} from "../lib/model-context-lookup";

interface Props {
  /** Current conversation messages. */
  messages: Message[];
  /** Active model id — resolves the context-window size. */
  model: string | null;
  /** Active backend / host:port — used to query the backend for the
   *  authoritative context length (Ollama /api/show today). */
  status: ServerStatus | null;
}

/** Render a token count as a compact "3.2K" / "850" string. */
function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Subtle context-usage indicator shown beside the composer. Uses the same
 * chars/4 estimator and per-model window the agent context-manager uses, so
 * the number tracks what the loop will actually budget against.
 */
export function ContextMeter({ messages, model, status }: Props) {
  // Bump on a successful backend lookup so the memo below re-resolves and we
  // swap the heuristic total for the authoritative one without remount.
  // Audit re-review LOW (2026-05-28): previously `[, setLookupTick]` —
  // the prefetch-landed tick was never wired into the memo deps, so
  // the authoritative window didn't paint until messages/status next
  // changed. Read the value too and include it in deps.
  const [lookupTick, setLookupTick] = useState(0);

  useEffect(() => {
    if (!model || !status?.running) return;
    let cancelled = false;
    prefetchContextLength(model, status).then((v) => {
      if (!cancelled && v != null) setLookupTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, [model, status]);

  const { used, total, pct } = useMemo(() => {
    const t = resolveContextTokens(model, status);
    const u = estimateMessagesTokens(messages);
    // Audit M-F5: when `resolveContextTokens` returns 0 (unknown backend),
    // u/t produces NaN → CSS renders "NaN%" width which collapses the bar
    // and surfaces as a console warning. Clamp the denominator.
    const pct = t > 0 ? Math.min(100, Math.max(0, Math.round((u / t) * 100))) : 0;
    return { used: u, total: t, pct };
    // lookupTick is in the dep array even though it's not read directly:
    // it forces a memo re-run when prefetch lands so resolveContextTokens
    // returns the authoritative value from the module-state cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, model, status, lookupTick]);

  if (messages.length === 0) return null;

  // Tint shifts amber past 75%, red past 90% — purely a CSS hook.
  const level = pct >= 90 ? "high" : pct >= 75 ? "mid" : "low";

  return (
    <div
      className={`context-meter context-meter-${level}`}
      data-testid="context-meter"
      title={`Estimated context use: ~${used} of ${total} tokens (${pct}%). Heuristic chars/4 estimate.`}
    >
      <div className="context-meter-bar" aria-hidden="true">
        <div className="context-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="context-meter-label">
        {fmt(used)} / {fmt(total)}
      </span>
    </div>
  );
}
