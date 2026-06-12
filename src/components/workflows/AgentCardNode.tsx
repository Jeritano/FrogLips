import { memo, useRef, type CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Clock, X } from "lucide-react";
import type { WorkflowNodeType } from "../../types";
import { WORKFLOW_NODE_TYPES } from "../../types";

export type CardRunState = "idle" | "running" | "done" | "failed";

export interface AgentCardNodeData {
  name: string;
  preset: string;
  schedule: string | null;
  /** Orchestration node kind; "agent" (default) shows no extra badge. */
  nodeType?: WorkflowNodeType;
  state: CardRunState;
  /** True when the card has an incoming edge — a single-card run is isolated. */
  midChain: boolean;
  /** Optional accent color (hex) for the card theme; null = neutral default. */
  color?: string | null;
  /**
   * True when the card was authored by the assistant with elevated tools and
   * has not yet been armed in the CardForm. Surfaces a "Needs review" chip on
   * the node so the unreviewed gate is visible on the canvas without opening
   * the form. The runner + scheduler refuse to run the card while this holds.
   */
  needsReview?: boolean;
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

  // Accent color drives a CSS custom property the stylesheet uses for the
  // left border + name tint. `data-themed` lets the CSS scope the accent
  // rules so a null color falls back to the neutral default chrome.
  const themeStyle = d.color
    ? ({ "--wf-card-accent": d.color } as CSSProperties)
    : undefined;

  return (
    <div
      className="wf-node"
      data-state={d.state}
      data-themed={d.color ? "true" : undefined}
      data-testid="wf-node"
      ref={ref}
      style={themeStyle}
    >
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <button
        type="button"
        className="wf-node-open"
        onClick={openForm}
        title="Edit agent"
      >
        <div className="wf-node-head">
          <span className="wf-node-name" title={d.name}>
            {d.name}
          </span>
          <span className={`wf-badge wf-badge-${d.state}`}>
            {STATE_LABEL[d.state]}
          </span>
        </div>
        <div className="wf-node-meta">
          <span className="wf-node-preset">{d.preset}</span>
          {d.needsReview && (
            <span
              className="wf-node-review"
              title="Authored by the assistant with elevated tools — open and Arm this card before it can run"
            >
              ⚠ Needs review
            </span>
          )}
          {d.nodeType && d.nodeType !== "agent" && (
            <span
              className="wf-node-nodetype"
              title={
                WORKFLOW_NODE_TYPES.find((nt) => nt.value === d.nodeType)?.blurb
              }
            >
              {WORKFLOW_NODE_TYPES.find((nt) => nt.value === d.nodeType)
                ?.label ?? d.nodeType}
            </span>
          )}
          {d.schedule && (
            <span
              className="wf-node-schedule"
              title={`Scheduled: ${d.schedule}`}
            >
              <Clock size={14} /> {d.schedule}
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
          <X size={14} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

/**
 * Audit M-F2 (2026-05-28): the parent WorkflowCanvas rebuilds the per-card
 * `data` object inside a useMemo that re-runs on every `cardStates`
 * change — i.e. every streamed delta during a workflow run. With the
 * default shallow-prop comparator, `memo(AgentCardNode)` sees a new
 * `data` reference each time and re-renders all N cards even when only
 * one card's state actually changed.
 *
 * Custom comparator: only re-render when the user-visible fields of THIS
 * card's data actually changed. Callback identities (onConfigure / onRun /
 * onDelete) are intentionally skipped — they close over c.id which is
 * stable; the parent wires them via stable refs in WorkflowsPage so the
 * closure identity is irrelevant to render output.
 */
function dataEqual(prev: NodeProps, next: NodeProps): boolean {
  const a = prev.data as AgentCardNodeData;
  const b = next.data as AgentCardNodeData;
  return (
    a.name === b.name &&
    a.preset === b.preset &&
    a.schedule === b.schedule &&
    a.state === b.state &&
    a.midChain === b.midChain &&
    a.color === b.color &&
    a.needsReview === b.needsReview &&
    // ReactFlow's NodeProps carry position + selected + dimensions —
    // re-render on those because they map to visible chrome.
    prev.selected === next.selected &&
    prev.positionAbsoluteX === next.positionAbsoluteX &&
    prev.positionAbsoluteY === next.positionAbsoluteY &&
    prev.width === next.width &&
    prev.height === next.height
  );
}

export const AgentCardNode = memo(AgentCardNodeImpl, dataEqual);
