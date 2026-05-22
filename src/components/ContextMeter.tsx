import { useMemo } from "react";
import type { Message } from "../types";
import { estimateMessagesTokens, modelContextTokens } from "../lib/agent-loop/context-manager";

interface Props {
  /** Current conversation messages. */
  messages: Message[];
  /** Active model id — resolves the context-window size. */
  model: string | null;
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
export function ContextMeter({ messages, model }: Props) {
  const { used, total, pct } = useMemo(() => {
    const t = modelContextTokens(model);
    const u = estimateMessagesTokens(messages);
    return { used: u, total: t, pct: Math.min(100, Math.round((u / t) * 100)) };
  }, [messages, model]);

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
