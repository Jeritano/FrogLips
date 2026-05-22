import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
} from "@xyflow/react";
import { AgentCardNode, type AgentCardNodeData, type CardRunState } from "./AgentCardNode";
import type { WorkflowCard, WorkflowEdge } from "../../types";

interface Props {
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
  cardStates: Record<string, CardRunState>;
  onCardsChange: (cards: WorkflowCard[]) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
  onConfigure: (id: string) => void;
  onRunCard: (id: string) => void;
  onDeleteCard: (id: string) => void;
  runningCardId: string | null;
}

const nodeTypes: NodeTypes = { agentCard: AgentCardNode };

/**
 * React Flow surface for the workflow graph. Card positions and edges are
 * lifted to the parent so they can be debounced-persisted; per-card run
 * state drives the live node badges.
 */
export function WorkflowCanvas({
  cards,
  edges,
  cardStates,
  onCardsChange,
  onEdgesChange,
  onConfigure,
  onRunCard,
  onDeleteCard,
  runningCardId,
}: Props) {
  const nodes = useMemo<Node<AgentCardNodeData>[]>(
    () =>
      cards.map((c) => ({
        id: c.id,
        type: "agentCard",
        position: { x: c.x, y: c.y },
        data: {
          name: c.name,
          preset: c.preset,
          schedule: c.schedule,
          state: cardStates[c.id] ?? "idle",
          onConfigure: () => onConfigure(c.id),
          onRun: () => onRunCard(c.id),
          onDelete: () => onDeleteCard(c.id),
        },
      })),
    [cards, cardStates, onConfigure, onRunCard, onDeleteCard],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        animated: runningCardId != null && e.from === runningCardId,
        className: "wf-edge",
      })),
    [edges, runningCardId],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeChanges(changes, nodes) as Node<AgentCardNodeData>[];
      // Only position changes round-trip to the card model.
      const byId = new Map(next.map((n) => [n.id, n.position]));
      onCardsChange(
        cards.map((c) => {
          const pos = byId.get(c.id);
          return pos ? { ...c, x: pos.x, y: pos.y } : c;
        }),
      );
    },
    [nodes, cards, onCardsChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, flowEdges);
      onEdgesChange(next.map((e) => ({ from: e.source, to: e.target })));
    },
    [flowEdges, onEdgesChange],
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const next = addEdge(conn, flowEdges);
      onEdgesChange(next.map((e) => ({ from: e.source, to: e.target })));
    },
    [flowEdges, onEdgesChange],
  );

  return (
    <div className="wf-canvas" data-testid="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        fitView
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ className: "wf-edge" }}
      >
        <Background gap={20} className="wf-bg" />
        <Controls className="wf-controls" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
