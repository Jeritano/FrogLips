import { useCallback, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
} from "@xyflow/react";
import { AgentCardNode, type AgentCardNodeData, type CardRunState } from "./AgentCardNode";
import { CardDeck } from "./CardDeck";
import type { WorkflowCard, WorkflowEdge } from "../../types";

interface Props {
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
  cardStates: Record<string, CardRunState>;
  onCardsChange: (cards: WorkflowCard[]) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
  onConfigure: (id: string, origin: DOMRect) => void;
  onRunCard: (id: string) => void;
  onDeleteCard: (id: string) => void;
  /** Create a fresh card placed at the given flow coords (drag-drop). */
  onPlaceCard: (x: number, y: number) => void;
  /** Open the centered form for a fresh card, flying from the deck rect. */
  onCreateFromDeck: (origin: DOMRect) => void;
  runningCardId: string | null;
}

const nodeTypes: NodeTypes = { agentCard: AgentCardNode };

/**
 * React Flow surface for the workflow graph — the "table top". Card positions
 * and edges are lifted to the parent so they can be debounced-persisted;
 * per-card run state drives the live node badges. The corner deck drags new
 * cards onto the pane via the onDrop/onDragOver pattern.
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
  onPlaceCard,
  onCreateFromDeck,
  runningCardId,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Cards with an incoming edge are mid-chain: a single-card run gives them
  // no upstream input, so the per-card Run button is disabled for them.
  const hasUpstream = useMemo(
    () => new Set(edges.map((e) => e.to)),
    [edges],
  );

  // Only placed cards appear on the table-top; unplaced cards live in the
  // deck and are kept in `cards` for persistence and the run list.
  const placedCards = useMemo(() => cards.filter((c) => c.placed), [cards]);

  const nodes = useMemo<Node<AgentCardNodeData>[]>(
    () =>
      placedCards.map((c) => ({
        id: c.id,
        type: "agentCard",
        position: { x: c.x, y: c.y },
        data: {
          name: c.name,
          preset: c.preset,
          schedule: c.schedule,
          state: cardStates[c.id] ?? "idle",
          midChain: hasUpstream.has(c.id),
          onConfigure: (rect: DOMRect) => onConfigure(c.id, rect),
          onRun: () => onRunCard(c.id),
          onDelete: () => onDeleteCard(c.id),
        },
      })),
    [placedCards, cardStates, hasUpstream, onConfigure, onRunCard, onDeleteCard],
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
      // Sync position and removal (Backspace) changes back to the card model.
      // A placed card missing from `next` was deleted; unplaced (deck) cards
      // are never nodes, so they pass through untouched.
      const byId = new Map(next.map((n) => [n.id, n.position]));
      onCardsChange(
        cards
          .filter((c) => !c.placed || byId.has(c.id))
          .map((c) => {
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

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/wf-card")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/wf-card")) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Center the ~200px-wide card on the cursor.
      onPlaceCard(pos.x - 100, pos.y - 60);
    },
    [screenToFlowPosition, onPlaceCard],
  );

  return (
    <div
      className="wf-canvas"
      data-testid="wf-canvas"
      ref={wrapRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
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
      <CardDeck onCreate={onCreateFromDeck} />
    </div>
  );
}
