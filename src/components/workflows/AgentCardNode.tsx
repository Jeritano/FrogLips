import { memo, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export type CardRunState = "idle" | "running" | "done" | "failed";

export interface AgentCardNodeData {
  name: string;
  preset: string;
  schedule: string | null;
  state: CardRunState;
  /** True when the card has an incoming edge — a single-card run is isolated. */
  midChain: boolean;
  /** Opens the centered form, flying from the clicked node's rect. */
  onConfigure: (rect: DOMRect) => void;
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
 * Custom React Flow node for one placed agent on the table-top. Clicking the
 * card body opens the centered edit form. Source/target handles enforce the
 * linear left→right wiring; the runner rejects branches/cycles.
 */
function AgentCardNodeImpl({ data }: NodeProps) {
  const d = data as AgentCardNodeData;
  const ref = useRef<HTMLDivElement>(null);

  function openForm() {
    if (ref.current) d.onConfigure(ref.current.getBoundingClientRect());
  }

  return (
    <div className="wf-node" data-state={d.state} data-testid="wf-node" ref={ref}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <button
        type="button"
        className="wf-node-open"
        onClick={openForm}
        title="Edit agent"
      >
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
      </button>
      <div className="wf-node-actions">
        <button
          type="button"
          className="wf-node-btn"
          onClick={openForm}
          title="Edit agent"
        >
          Edit
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
