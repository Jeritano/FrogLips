import { useEffect, useRef, type ReactNode } from "react";
import { Circle, CircleDashed, CheckCircle2, XCircle } from "lucide-react";
import type { CardRunState } from "./AgentCardNode";

export interface CardRunInfo {
  id: string;
  name: string;
  state: CardRunState;
  output: string;
  error?: string;
}

interface Props {
  cards: CardRunInfo[];
  /** Id of the card currently running, for the auto-scroll-into-view. */
  runningCardId: string | null;
  /** Scroll + frame the matching node on the canvas (failed-card click). */
  onFocusNode: (id: string) => void;
  /** Re-run the graph resuming from this card (failed/partial recovery). */
  onRerunFromCard: (id: string) => void;
}

const STATE_ICON: Record<CardRunState, ReactNode> = {
  idle: <Circle size={14} />,
  running: <CircleDashed size={14} />,
  done: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
};

/**
 * Side panel: live per-card status and output.
 *
 * Run/Stop has moved into the global top-bar (next to the theme toggle) so
 * the workflow header stays at parity with chat's ModelPicker — see
 * WorkflowsPage.editorHeader. This panel is now read-only status PLUS two
 * recovery affordances (adversarial review UX, 2026-06-12):
 *   - the running card auto-scrolls into view as the run advances, so a long
 *     chain doesn't bury the active step below the fold;
 *   - a failed card's row is clickable (focus its canvas node) and offers a
 *     "re-run from here" action that resumes the run from that card.
 */
export function RunPanel({
  cards,
  runningCardId,
  onFocusNode,
  onRerunFromCard,
}: Props) {
  // Auto-scroll the running card into view. Keyed on the running id so it
  // fires once per card transition, not on every streamed output update.
  const runningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (runningCardId && runningRef.current) {
      runningRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [runningCardId]);

  return (
    <aside className="wf-run-panel" data-testid="wf-run-panel">
      <div className="wf-run-head">
        <span>Status</span>
      </div>
      <div className="wf-run-list">
        {cards.length === 0 && (
          <p className="wf-run-empty">No cards on the canvas yet.</p>
        )}
        {cards.map((c) => {
          const isRunning = c.id === runningCardId;
          const isFailed = c.state === "failed";
          return (
            <div
              key={c.id}
              className="wf-run-item"
              data-state={c.state}
              ref={isRunning ? runningRef : undefined}
            >
              <div className="wf-run-item-head">
                <span
                  className={`wf-run-icon wf-run-icon-${c.state}`}
                  aria-hidden="true"
                >
                  {STATE_ICON[c.state]}
                </span>
                {isFailed ? (
                  // A failed row jumps to the offending node on the canvas so
                  // the user can fix it without hunting for it on a busy graph.
                  // Inline reset keeps the button looking like the plain name
                  // text it replaces (no dedicated CSS class lives in this
                  // component's stylesheet scope).
                  <button
                    type="button"
                    className="wf-run-item-name"
                    onClick={() => onFocusNode(c.id)}
                    title="Show this card on the canvas"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      textDecoration: "underline",
                      textUnderlineOffset: "2px",
                      color: "inherit",
                      font: "inherit",
                    }}
                  >
                    {c.name}
                  </button>
                ) : (
                  <span className="wf-run-item-name">{c.name}</span>
                )}
              </div>
              {c.output && <pre className="wf-run-output">{c.output}</pre>}
              {c.error && (
                <pre className="wf-run-output wf-run-error">{c.error}</pre>
              )}
              {isFailed && (
                <button
                  type="button"
                  className="wf-btn"
                  onClick={() => onRerunFromCard(c.id)}
                  title="Re-run the flow starting from this card"
                  style={{ marginTop: "var(--space-2)", width: "100%" }}
                >
                  Re-run from here
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
