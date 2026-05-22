import type { WorkflowCard, WorkflowGraph } from "../../types";

/** Thrown when a graph is not a valid linear v1 chain. */
export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphError";
  }
}

/**
 * Resolve the linear execution order of a workflow graph.
 *
 * v1 supports only linear chains: every card has at most one incoming and one
 * outgoing edge, all cards are connected into a single chain, and there are no
 * cycles. Anything else throws `WorkflowGraphError` with a clear reason.
 *
 * Returns cards in run order — the start card (no incoming edge) first.
 */
export function resolveLinearOrder(graph: WorkflowGraph): WorkflowCard[] {
  const { cards, edges } = graph;
  if (cards.length === 0) return [];

  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const e of edges) {
    if (!byId.has(e.from)) {
      throw new WorkflowGraphError(`Edge references unknown card "${e.from}".`);
    }
    if (!byId.has(e.to)) {
      throw new WorkflowGraphError(`Edge references unknown card "${e.to}".`);
    }
  }

  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const next = new Map<string, string>();
  for (const c of cards) {
    outDeg.set(c.id, 0);
    inDeg.set(c.id, 0);
  }
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    next.set(e.from, e.to);
  }

  for (const c of cards) {
    if ((outDeg.get(c.id) ?? 0) > 1) {
      throw new WorkflowGraphError(
        `Card "${c.name}" has multiple outgoing edges — branching is not supported in v1.`,
      );
    }
    if ((inDeg.get(c.id) ?? 0) > 1) {
      throw new WorkflowGraphError(
        `Card "${c.name}" has multiple incoming edges — merging is not supported in v1.`,
      );
    }
  }

  // Single card with no edges is a trivially valid chain.
  if (cards.length === 1 && edges.length === 0) return [...cards];

  const starts = cards.filter((c) => (inDeg.get(c.id) ?? 0) === 0);
  if (starts.length === 0) {
    throw new WorkflowGraphError("Workflow has no start card — graph contains a cycle.");
  }
  if (starts.length > 1) {
    throw new WorkflowGraphError(
      "Workflow has multiple disconnected start cards — only a single linear chain is supported.",
    );
  }

  const order: WorkflowCard[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = starts[0].id;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new WorkflowGraphError("Workflow contains a cycle.");
    }
    seen.add(cursor);
    order.push(byId.get(cursor)!);
    cursor = next.get(cursor);
  }

  if (order.length !== cards.length) {
    throw new WorkflowGraphError(
      "Workflow has cards not connected to the main chain — only a single linear chain is supported.",
    );
  }
  return order;
}

/**
 * Validate a graph without running it. Returns `{ ok: true, order }` or
 * `{ ok: false, error }` — a non-throwing wrapper around `resolveLinearOrder`
 * suitable for UI gating (e.g. disabling a "Run" button).
 */
export function validateGraph(
  graph: WorkflowGraph,
): { ok: true; order: WorkflowCard[] } | { ok: false; error: string } {
  try {
    return { ok: true, order: resolveLinearOrder(graph) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
