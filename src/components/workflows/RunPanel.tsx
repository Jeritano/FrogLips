import { memo, useEffect, useRef, type ReactNode } from "react";
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
  /**
   * Active agent write-workspace (`api.agentGetWorkspace()` result). `null`
   * means no project folder is set, so file-writing cards fall back to the
   * home dir — we surface that as a warning chip so "where do files go?" is
   * never a mystery during a run. `undefined` = not yet loaded (render nothing).
   */
  workspace?: string | null;
}

const STATE_ICON: Record<CardRunState, ReactNode> = {
  idle: <Circle size={14} />,
  running: <CircleDashed size={14} />,
  done: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
};

/**
 * One status row. Extracted + memoized (perf 2026-06-12) so a 16ms streaming
 * flush — which rebuilds the whole `CardRunInfo[]` with fresh object refs even
 * for unchanged cards — only reconciles the ONE row whose `output` grew. The
 * comparator checks the visible fields; the parent's handlers are `useCallback`
 * (stable), so non-streaming rows skip rendering entirely during a run.
 */
const RunPanelRow = memo(
  function RunPanelRow({
    card: c,
    isRunning,
    rowRef,
    onFocusNode,
    onRerunFromCard,
  }: {
    card: CardRunInfo;
    isRunning: boolean;
    rowRef?: React.Ref<HTMLDivElement>;
    onFocusNode: (id: string) => void;
    onRerunFromCard: (id: string) => void;
  }) {
    const isFailed = c.state === "failed";
    return (
      <div
        className="wf-run-item"
        data-state={c.state}
        ref={isRunning ? rowRef : undefined}
      >
        <div className="wf-run-item-head">
          <span
            className={`wf-run-icon wf-run-icon-${c.state}`}
            aria-hidden="true"
          >
            {STATE_ICON[c.state]}
          </span>
          {isFailed ? (
            // A failed row jumps to the offending node on the canvas so the user
            // can fix it without hunting for it on a busy graph. Inline reset
            // keeps the button looking like the plain name text it replaces.
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
        {c.error && <pre className="wf-run-output wf-run-error">{c.error}</pre>}
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
  },
  // `card` is a fresh object every flush, so compare its VISIBLE fields, not its
  // ref — otherwise every row re-renders on every streamed token. Handlers are
  // useCallback-stable so they're intentionally not compared.
  (a, b) =>
    a.isRunning === b.isRunning &&
    a.rowRef === b.rowRef &&
    a.card.id === b.card.id &&
    a.card.name === b.card.name &&
    a.card.state === b.card.state &&
    a.card.output === b.card.output &&
    a.card.error === b.card.error,
);

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
  workspace,
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
      {/* Where-do-files-go indicator. A flow run never has an interactive
          confirm handler, so file-writing cards write to the active agent
          workspace — and an unset workspace silently scatters files under ~.
          Surface the destination so it's never a mystery. `undefined` = the
          workspace fetch hasn't resolved yet, so render nothing. */}
      {workspace !== undefined &&
        (workspace ? (
          <div
            className="wf-run-workspace"
            data-testid="wf-run-workspace"
            title={`Files write to: ${workspace}`}
          >
            <span className="wf-run-workspace-label">Files write to:</span>
            <span className="wf-run-workspace-path">{workspace}</span>
          </div>
        ) : (
          <div
            className="wf-run-workspace wf-run-workspace-warn"
            data-testid="wf-run-workspace-warn"
            role="status"
            title="No project folder is set — file-writing cards will write under your home folder. Set a workspace in Agent settings."
          >
            ⚠ Files write to your home folder — set a project folder in Agent
            settings
          </div>
        ))}
      <div className="wf-run-list">
        {cards.length === 0 && (
          <p className="wf-run-empty">No cards on the canvas yet.</p>
        )}
        {cards.map((c) => (
          <RunPanelRow
            key={c.id}
            card={c}
            isRunning={c.id === runningCardId}
            rowRef={c.id === runningCardId ? runningRef : undefined}
            onFocusNode={onFocusNode}
            onRerunFromCard={onRerunFromCard}
          />
        ))}
      </div>
    </aside>
  );
}
