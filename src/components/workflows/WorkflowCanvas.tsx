import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
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
import {
  AgentCardNode,
  type AgentCardNodeData,
  type CardRunState,
} from "./AgentCardNode";
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
  /**
   * Open the centered form for a fresh card. `origin` is the deck rect (the
   * fly-in source); `position` is a flow-coordinate inside the currently
   * visible canvas area, so the new card always lands where the user can see
   * it rather than off-screen.
   */
  onCreateFromDeck: (
    origin: DOMRect,
    position: { x: number; y: number },
  ) => void;
  runningCardId: string | null;
  /**
   * Hand the page an imperative "frame this node" function so a failed-card
   * click in the status panel can scroll + zoom the canvas to that node. The
   * page stores it in a ref and calls it on demand; passing `null` on unmount
   * lets the page drop the stale reference.
   */
  onRegisterFocus?: (fn: ((id: string) => void) | null) => void;
}

const nodeTypes: NodeTypes = { agentCard: AgentCardNode };

/**
 * Reconcile a React Flow `NodeChange` batch back onto the card model.
 *
 * Deletion is taken ONLY from explicit `remove` changes — a node merely absent
 * from `applyNodeChanges` output is NOT deleted. React Flow can emit
 * measurement/select batches before a freshly added node is in its internal
 * store; treating that absence as a deletion would silently drop a just-created
 * card. Positions come from the applied changes so drag moves are reflected.
 */
export function reconcileNodeChanges(
  changes: NodeChange[],
  nodes: Node<AgentCardNodeData>[],
  cards: WorkflowCard[],
): WorkflowCard[] {
  const removed = new Set(
    changes
      .filter(
        (c): c is Extract<NodeChange, { type: "remove" }> =>
          c.type === "remove",
      )
      .map((c) => c.id),
  );
  const next = applyNodeChanges(changes, nodes) as Node<AgentCardNodeData>[];
  const posById = new Map(next.map((n) => [n.id, n.position]));
  return cards
    .filter((c) => !removed.has(c.id))
    .map((c) => {
      const pos = posById.get(c.id);
      return pos ? { ...c, x: pos.x, y: pos.y } : c;
    });
}

/**
 * Cascade offset for the n-th new card relative to an anchor flow-coordinate.
 * Cards are nudged +CASCADE px down-right per existing card and wrap every
 * CASCADE_WRAP cards, so a run of new cards stays clustered in the visible
 * area instead of marching off-screen.
 */
export function cascadeOffset(n: number): { dx: number; dy: number } {
  const CASCADE = 32;
  const CASCADE_WRAP = 6;
  const step = n % CASCADE_WRAP;
  return { dx: step * CASCADE, dy: step * CASCADE };
}

/**
 * React Flow surface for the workflow graph — the "table top". Card positions
 * and edges are lifted to the parent so they can be debounced-persisted;
 * per-card run state drives the live node badges. The corner deck's top card
 * opens the centered form; saving the form lands a node directly on the pane.
 */
function WorkflowCanvasInner({
  cards,
  edges,
  cardStates,
  onCardsChange,
  onEdgesChange,
  onConfigure,
  onRunCard,
  onDeleteCard,
  onCreateFromDeck,
  runningCardId,
  onRegisterFocus,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Register an imperative node-focuser (review UX #5). `fitView` with an
  // explicit node id frames + zooms that single node; the same animated
  // padding as the new-card safety-net keeps the motion consistent. Cleared
  // on unmount so the page never calls into a torn-down ReactFlow instance.
  useEffect(() => {
    onRegisterFocus?.((id: string) => {
      void fitView({
        nodes: [{ id }],
        padding: 0.4,
        duration: 300,
        maxZoom: 1.5,
      });
    });
    return () => onRegisterFocus?.(null);
  }, [onRegisterFocus, fitView]);

  // Card width is ~420px; half that recenters the dropped node under the
  // visible-area center rather than placing its top-left corner there.
  const CARD_HALF_W = 210;
  const CARD_HALF_H = 70;

  // Compute a flow-coordinate near the center of the currently-visible canvas,
  // then cascade it by the number of already-placed cards so repeated creates
  // stay clustered on-screen instead of overlapping exactly.
  const nextCardPosition = useCallback((): { x: number; y: number } => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
      : { x: 0, y: 0 };
    const { dx, dy } = cascadeOffset(cards.filter((c) => c.placed).length);
    return { x: center.x - CARD_HALF_W + dx, y: center.y - CARD_HALF_H + dy };
  }, [cards, screenToFlowPosition]);

  const handleCreateFromDeck = useCallback(
    (origin: DOMRect) => {
      onCreateFromDeck(origin, nextCardPosition());
    },
    [onCreateFromDeck, nextCardPosition],
  );

  // Safety net: whenever the placed-card count grows, re-fit the viewport so a
  // newly created card is always brought into view even if placement math is
  // off. Animated with padding so existing cards stay framed too.
  const placedCount = cards.filter((c) => c.placed).length;
  const prevPlacedCount = useRef(placedCount);
  useEffect(() => {
    if (placedCount > prevPlacedCount.current) {
      fitView({ padding: 0.2, duration: 300 });
    }
    prevPlacedCount.current = placedCount;
  }, [placedCount, fitView]);

  // Cards with an incoming edge are mid-chain: a single-card run gives them
  // no upstream input, so the per-card Run button is disabled for them.
  const hasUpstream = useMemo(() => new Set(edges.map((e) => e.to)), [edges]);

  // Only placed cards appear on the table-top; unplaced cards live in the
  // deck and are kept in `cards` for persistence and the run list.
  const placedCards = useMemo(() => cards.filter((c) => c.placed), [cards]);

  // `nodes` is re-derived from `cards` every render (cards is the source of
  // truth, persisted by the parent). React Flow measures each node and writes
  // its dimensions back through `dimensions` changes — but those would be lost
  // on the next derive, leaving every node `nodeHasDimensions()===false` and
  // therefore `visibility:hidden` forever. Cache measured sizes in a ref and
  // re-attach them so created cards actually paint on the canvas.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(
    new Map(),
  );

  // When a card is deleted via the AgentCardNode "×" button (state-side
  // delete from WorkflowsPage), React Flow doesn't emit a `remove` change —
  // the node simply disappears from `cards`. The `dimensions` cache would
  // then leak entries forever. Prune entries whose ids no longer exist so the
  // map stays bounded by the live card count.
  useEffect(() => {
    const live = new Set(cards.map((c) => c.id));
    const m = measuredRef.current;
    for (const id of m.keys()) {
      if (!live.has(id)) m.delete(id);
    }
  }, [cards]);

  const nodes = useMemo<Node<AgentCardNodeData>[]>(
    () =>
      placedCards.map((c) => ({
        id: c.id,
        type: "agentCard",
        position: { x: c.x, y: c.y },
        // `.wf-node` is a fixed 200px-wide card; the estimate height seeds
        // `nodeHasDimensions` so the node is visible on first paint, before
        // the ResizeObserver reports the real measurement.
        initialWidth: 200,
        initialHeight: 132,
        ...(measuredRef.current.has(c.id)
          ? { measured: measuredRef.current.get(c.id) }
          : {}),
        data: {
          name: c.name,
          preset: c.preset,
          schedule: c.schedule,
          nodeType: c.nodeType ?? "agent",
          state: cardStates[c.id] ?? "idle",
          midChain: hasUpstream.has(c.id),
          color: c.color ?? null,
          // Surface the unreviewed-card gate as a chip on the node (see
          // AgentCardNode). Refresh of this field is covered by the
          // `placedCards` dependency below.
          needsReview: c.needsReview === true,
          onConfigure: (rect: DOMRect) => onConfigure(c.id, rect),
          onRun: () => onRunCard(c.id),
          onDelete: () => onDeleteCard(c.id),
        },
      })),
    [
      placedCards,
      cardStates,
      hasUpstream,
      onConfigure,
      onRunCard,
      onDeleteCard,
    ],
  );

  // Two-click edge-disconnect armed state — declared above flowEdges so
  // the memo can read it. See handleEdgeClick below for the lifecycle.
  const [armedEdgeId, setArmedEdgeId] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current != null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => clearArmTimer(), [clearArmTimer]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const id = `${e.from}->${e.to}`;
        return {
          id,
          source: e.from,
          target: e.to,
          animated: runningCardId != null && e.from === runningCardId,
          // `selected:true` triggers ReactFlow's built-in selected styling,
          // which surfaces the armed-state visual for the two-click
          // disconnect (audit C-F1). 3-second window from first click.
          selected: armedEdgeId === id,
          className: armedEdgeId === id ? "wf-edge wf-edge-armed" : "wf-edge",
        };
      }),
    [edges, runningCardId, armedEdgeId],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Persist React Flow's measurements across the cards→nodes re-derive so
      // nodes keep their dimensions (and stay visible) on every render.
      for (const ch of changes) {
        if (ch.type === "dimensions" && ch.dimensions) {
          measuredRef.current.set(ch.id, ch.dimensions);
        } else if (ch.type === "remove") {
          measuredRef.current.delete(ch.id);
        }
      }
      onCardsChange(reconcileNodeChanges(changes, nodes, cards));
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

  // Click an edge to delete it. React Flow's built-in "select + Delete"
  // dance doesn't survive our re-render cycle (the parent rebuilds the
  // edge array from `{from,to}` shape, losing internal `selected` state)
  // so this is the only reliable disconnect affordance.
  //
  // Audit C-F1 (2026-05-27): previously used `window.confirm()` for the
  // two-click guard, which Tauri 2 WKWebView blocks → the prompt never
  // appeared and `ok` was always falsy → edge deletion silent no-op.
  // Replaced with an in-component armed-state two-click pattern: first
  // click arms the edge for 3 s (visual highlight via the `selected`
  // class through ReactFlow), second click within the window
  // disconnects. Mid-flight clicks on a different edge re-arm.
  // State + cleanup hook declared above flowEdges so the edge memo can
  // read `armedEdgeId` to surface the visual armed state.
  const handleEdgeClick = useCallback(
    (_evt: React.MouseEvent, edge: Edge) => {
      if (armedEdgeId === edge.id) {
        // Second click on the armed edge → commit.
        clearArmTimer();
        setArmedEdgeId(null);
        onEdgesChange(
          flowEdges
            .filter((e) => e.id !== edge.id)
            .map((e) => ({ from: e.source, to: e.target })),
        );
        return;
      }
      // First click (or click on a different edge while armed) → re-arm.
      clearArmTimer();
      setArmedEdgeId(edge.id);
      armTimerRef.current = setTimeout(() => {
        setArmedEdgeId(null);
        armTimerRef.current = null;
      }, 3000);
    },
    [armedEdgeId, clearArmTimer, flowEdges, onEdgesChange],
  );

  return (
    <div className="wf-canvas" data-testid="wf-canvas" ref={wrapRef}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onEdgeClick={handleEdgeClick}
        fitView
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          className: "wf-edge",
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          className="wf-bg"
        />
        <Controls className="wf-controls" showInteractive={false} />
      </ReactFlow>
      <CardDeck onCreate={handleCreateFromDeck} />
    </div>
  );
}

/**
 * Memoized (perf 2026-06-12). During a run the parent RunSurface re-renders on
 * every 16ms streaming flush, but the canvas only depends on `cardStates`
 * (now a referentially-stable status map — see RunSurface), `runningCardId`,
 * `cards`/`edges` (change only on edits), and useCallback-stable handlers. So
 * an output-only flush is a shallow-equal no-op here: the canvas, its `nodes`
 * memo, and React Flow's internal node diff all skip, instead of rebuilding
 * every node 60×/sec for the whole run.
 */
export const WorkflowCanvas = memo(WorkflowCanvasInner);
