/* ── Workflow node-handler contract ─────────────────────────────────────────
 *
 * Each orchestration node type (agent / moa / consistency / critic / cascade /
 * router / blackboard / budget) is a self-contained {@link NodeHandler} module.
 * The registry (`registry.ts`) maps a {@link WorkflowNodeType} to its handler;
 * `nodes.ts` stays thin and dispatches through the registry.
 *
 * IMPORTANT — persisted shape is unchanged. A handler's `buildDefaultConfig`
 * returns a plain `WorkflowNodeConfig` (the same flat bag persisted in
 * `graph_json`); there is NO discriminant and NO per-type serialization. The
 * `Pick<WorkflowNodeConfig, …>` typed views inside each handler are
 * COMPILE-TIME ONLY — a structural subset of the one flat interface — so saved
 * flows keep deserializing byte-for-byte.
 */

import type { WorkflowCard, WorkflowNodeConfig, WorkflowNodeType } from "../../../types";
import type { AgentRunOptions } from "../../agent-loop/types";
import type { loadAllPresets } from "../../agent-presets";

type Presets = ReturnType<typeof loadAllPresets>;

/** Context handed to every node handler. `base` is the `AgentRunOptions` the
 *  runner already built for this card via `buildCardOptions`. */
export interface NodeRunContext {
  card: WorkflowCard;
  base: AgentRunOptions;
  presets: Presets;
  signal: AbortSignal;
  /** Stream progress / status text to the card's live output (onCardOutput). */
  emit: (text: string) => void;
}

/**
 * One orchestration node type's behavior + metadata. Handlers are registered in
 * `registry.ts` keyed by {@link WorkflowNodeType}.
 */
export interface NodeHandler {
  /** The node type this handler implements. */
  type: WorkflowNodeType;
  /** Human label shown in the CardForm picker. */
  label: string;
  /** One-line blurb shown under the label. */
  blurb: string;
  /** Whether `create_flow` ADVANCED mode may author this node type. */
  advancedAllowed: boolean;
  /** Run the node and resolve to its final output text. */
  run: (ctx: NodeRunContext) => Promise<string>;
  /**
   * Mint a minimal valid `nodeConfig` for this node type when the advanced
   * `create_flow` builder requests it. `verifyCmd` is only meaningful for the
   * critic/cascade types (the loop runs it before each critique pass); other
   * handlers ignore it. Returns `null` for types that carry no config (agent).
   */
  buildDefaultConfig: (verifyCmd: string | null) => WorkflowNodeConfig | null;
}
