/* ── Node-handler registry ──────────────────────────────────────────────────
 *
 * Maps every {@link WorkflowNodeType} to its self-contained {@link NodeHandler}.
 * `nodes.ts` dispatches through this; `create-flow.ts` reads
 * `buildDefaultConfig` / `advancedAllowed` from it.
 *
 * Dependency direction (avoids a types.ts ↔ workflow cycle): the registry
 * imports `WorkflowNodeType` from `types.ts`, NEVER the reverse. A parity test
 * (`registry.test.ts`) asserts the registry keys === `WORKFLOW_NODE_TYPES` ===
 * the `WorkflowNodeType` union so a new node type can't be added without a
 * handler.
 */

import type { WorkflowNodeType } from "../../../types";
import { agentHandler } from "./agent";
import { blackboardHandler } from "./blackboard";
import { budgetHandler } from "./budget";
import { cascadeHandler } from "./cascade";
import { consistencyHandler } from "./consistency";
import { criticHandler } from "./critic";
import { moaHandler } from "./moa";
import { parallelHandler } from "./parallel";
import { routerHandler } from "./router";
import type { NodeHandler } from "./types";

/** The single source of truth mapping node type → handler. `Record` over the
 *  `WorkflowNodeType` union forces every member to have a registered handler at
 *  compile time. */
export const HANDLERS: Record<WorkflowNodeType, NodeHandler> = {
  agent: agentHandler,
  moa: moaHandler,
  consistency: consistencyHandler,
  critic: criticHandler,
  cascade: cascadeHandler,
  router: routerHandler,
  blackboard: blackboardHandler,
  budget: budgetHandler,
  parallel: parallelHandler,
};

/** Resolve a card's node type to its handler, defaulting to the plain `agent`
 *  pass for an absent/unknown type (matches the old `dispatchNode` default). */
export function handlerFor(nodeType?: WorkflowNodeType | null): NodeHandler {
  return (nodeType && HANDLERS[nodeType]) || HANDLERS.agent;
}
