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
}

const STATE_ICON: Record<CardRunState, string> = {
  idle: "○",
  running: "◐",
  done: "●",
  failed: "✕",
};

/**
 * Side panel: live per-card status and output.
 *
 * Run/Stop has moved into the global top-bar (next to the theme toggle) so
 * the workflow header stays at parity with chat's ModelPicker — see
 * WorkflowsPage.editorHeader. This panel is now read-only status.
 */
export function RunPanel({ cards }: Props) {
  return (
    <aside className="wf-run-panel" data-testid="wf-run-panel">
      <div className="wf-run-head">
        <span>Status</span>
      </div>
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
