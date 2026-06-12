/* ── Shareable Flows ─────────────────────────────────────────────────────────
 *
 * A portable, versioned document for exporting/importing a Flow as text (copy
 * to clipboard → paste anywhere → import on another machine). Import is
 * validated twice: structurally here (schema version + linear-graph check), and
 * again on save by the Rust `validate_graph_json` (size cap + shape), so a
 * pasted blob can never persist a malformed or oversized graph.
 */

import type { WorkflowGraph } from "../../types";
import { validateGraph } from "./graph";

/** Bump when the doc shape changes incompatibly. */
export const FLOW_SCHEMA_VERSION = 1;
const MAGIC = "froglips_flow";

export interface FlowDoc {
  froglips_flow: number; // schema version
  name: string;
  graph: WorkflowGraph;
}

/** Serialize a Flow to a portable, pretty-printed document string. */
export function flowToDoc(name: string, graph: WorkflowGraph): string {
  const doc: FlowDoc = {
    froglips_flow: FLOW_SCHEMA_VERSION,
    name: name.trim() || "Imported Flow",
    graph,
  };
  return JSON.stringify(doc, null, 2);
}

export type FlowImport =
  | { ok: true; name: string; graph: WorkflowGraph }
  | { ok: false; error: string };

/** Parse + validate a pasted/loaded Flow document. Never throws. */
export function flowFromDoc(text: string): FlowImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "Not valid JSON — paste the whole exported Flow.",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Not a Flow document." };
  }
  const d = parsed as Record<string, unknown>;
  if (typeof d[MAGIC] !== "number") {
    return { ok: false, error: "Not a Froglips Flow export." };
  }
  if (d[MAGIC] !== FLOW_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported Flow version ${String(d[MAGIC])} (this build reads v${FLOW_SCHEMA_VERSION}).`,
    };
  }
  const g = d.graph as Partial<WorkflowGraph> | undefined;
  if (!g || !Array.isArray(g.cards) || !Array.isArray(g.edges)) {
    return {
      ok: false,
      error: "Flow document is missing its cards/edges graph.",
    };
  }
  const graph: WorkflowGraph = { cards: g.cards, edges: g.edges };
  const v = validateGraph(graph);
  if (!v.ok) {
    return { ok: false, error: `Invalid Flow graph: ${v.error}` };
  }
  const name =
    typeof d.name === "string" && d.name.trim()
      ? d.name.trim()
      : "Imported Flow";
  return { ok: true, name, graph };
}
