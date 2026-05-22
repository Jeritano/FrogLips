import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type CardRunState = "idle" | "running" | "done" | "failed";

export interface AgentCardNodeData {
  name: string;
  preset: string;
  schedule: string | null;
  state: CardRunState;
  /** True when the card has an incoming edge — a single-card run is isolated. */
  midChain: boolean;
  onConfigure: () => void;
  onRun: () => void;
  onDelete: () => void;
  [key: string]: unknown;
}

const STATE_LABEL: Record<CardRunState, string> = {
  idle: "Idle",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

/**
 * Custom React Flow node for one configured agent in a workflow chain.
 * Source/target handles enforce the linear left→right wiring; the runner
 * rejects branches/cycles, the page surfaces a warning for them.
 */
function AgentCardNodeImpl({ data }: NodeProps) {
  const d = data as AgentCardNodeData;
  return (
    <div className="wf-node" data-state={d.state} data-testid="wf-node">
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="wf-node-name" title={d.name}>{d.name}</span>
        <span className={`wf-badge wf-badge-${d.state}`}>{STATE_LABEL[d.state]}</span>
      </div>
      <div className="wf-node-meta">
        <span className="wf-node-preset">{d.preset}</span>
        {d.schedule && (
          <span className="wf-node-schedule" title={`Scheduled: ${d.schedule}`}>
            ⏱ {d.schedule}
          </span>
        )}
      </div>
      <div className="wf-node-actions">
        <button
          type="button"
          className="wf-node-btn"
          onClick={d.onConfigure}
          title="Configure agent"
        >
          Configure
        </button>
        <button
          type="button"
          className="wf-node-btn"
          onClick={d.onRun}
          disabled={d.state === "running" || d.midChain}
          title={
            d.midChain
              ? "Disabled: a mid-chain card has no upstream input when run alone"
              : "Run this card alone"
          }
        >
          Run
        </button>
        <button
          type="button"
          className="wf-node-btn wf-node-btn-danger"
          onClick={d.onDelete}
          title="Delete card"
          aria-label="Delete card"
        >
          ×
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

export const AgentCardNode = memo(AgentCardNodeImpl);
