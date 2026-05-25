import type { CardRunState } from "./AgentCardNode";

export interface CardRunInfo {
  id: string;
  name: string;
  state: CardRunState;
  output: string;
  error?: string;
}

interface Props {
  running: boolean;
  canRun: boolean;
  cards: CardRunInfo[];
  onRun: () => void;
  onStop: () => void;
}

const STATE_ICON: Record<CardRunState, string> = {
  idle: "○",
  running: "◐",
  done: "●",
  failed: "✕",
};

/** Side panel: run/stop controls + live per-card state and output. */
export function RunPanel({
  running,
  canRun,
  cards,
  onRun,
  onStop,
}: Props) {
  return (
    <aside className="wf-run-panel" data-testid="wf-run-panel">
      <div className="wf-run-head">
        <span>Run</span>
        {running ? (
          <button type="button" className="wf-btn wf-btn-danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={onRun}
            disabled={!canRun}
            title={canRun ? "Run workflow" : "Add cards and a valid linear chain first"}
          >
            Run workflow
          </button>
        )}
      </div>
      <p className="wf-run-hint">
        Approval is set per-agent in the card's Edit form. Cards with
        Auto-approve checked run their normal-risk tools without prompts.
      </p>
      <div className="wf-run-list">
        {cards.length === 0 && (
          <p className="wf-run-empty">No cards on the canvas yet.</p>
        )}
        {cards.map((c) => (
          <div key={c.id} className="wf-run-item" data-state={c.state}>
            <div className="wf-run-item-head">
              <span className={`wf-run-icon wf-run-icon-${c.state}`} aria-hidden="true">
                {STATE_ICON[c.state]}
              </span>
              <span className="wf-run-item-name">{c.name}</span>
            </div>
            {c.output && <pre className="wf-run-output">{c.output}</pre>}
            {c.error && <pre className="wf-run-output wf-run-error">{c.error}</pre>}
          </div>
        ))}
      </div>
    </aside>
  );
}
