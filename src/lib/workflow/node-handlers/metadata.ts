/* ── Node-handler metadata (cycle-free) ─────────────────────────────────────
 *
 * The per-node-type METADATA the handlers AND `create-flow.ts` both need —
 * label / blurb / `advancedAllowed` / `buildDefaultConfig` — with ZERO runtime
 * dependencies (no `runAgentLoop`, no tools, no agent-loop chain).
 *
 * Why this is split out from the runtime handlers: there is an import cycle —
 * `create-flow.ts` is imported by the agent-loop tool-registry, and the runtime
 * handlers import `shared.ts` → the agent loop. If `create-flow.ts` imported the
 * runtime registry it would close that cycle at module-init and leave
 * `TOOL_REGISTRY` / `HANDLERS` observed half-initialized. By depending on THIS
 * leaf module instead, `create-flow.ts` gets the metadata it needs (the advanced
 * allowlist + default-config builder) without ever reaching the agent loop. The
 * runtime handler objects (`agent.ts`, `moa.ts`, …) compose their metadata FROM
 * here, so this stays the single source of truth.
 */

import type { WorkflowNodeConfig, WorkflowNodeType } from "../../../types";

/** Static metadata for one node type. The runtime {@link NodeHandler} spreads
 *  this and adds the `run` body. */
export interface NodeMeta {
  type: WorkflowNodeType;
  label: string;
  blurb: string;
  /** Whether `create_flow` ADVANCED mode may author this node type. */
  advancedAllowed: boolean;
  /** Mint a minimal valid `nodeConfig` for the advanced builder. `verifyCmd` is
   *  only honored by critic/cascade; other types ignore it and may return null. */
  buildDefaultConfig: (verifyCmd: string | null) => WorkflowNodeConfig | null;
}

export const NODE_META: Record<WorkflowNodeType, NodeMeta> = {
  agent: {
    type: "agent",
    label: "Agent",
    blurb: "One agent pass (default).",
    advancedAllowed: true,
    // A plain pass carries no orchestration config.
    buildDefaultConfig: () => null,
  },
  moa: {
    type: "moa",
    label: "Mixture-of-Agents",
    blurb: "N agents in parallel → synthesized answer.",
    advancedAllowed: true,
    // MoA: 3 proposers → one synthesis pass. Matches runMoa's runtime
    // `members ?? 3` default — stamp it explicitly so the built value tracks the
    // handler's intent rather than relying on the fallback.
    buildDefaultConfig: () => ({ members: 3 }),
  },
  consistency: {
    type: "consistency",
    label: "Self-Consistency",
    blurb: "Sample N times → vote / merge.",
    advancedAllowed: true,
    // Self-consistency: 5 samples → vote/merge. Matches runConsistency's runtime
    // `members ?? 5` default. (A shared `members:3` literal would silently
    // under-sample an advanced-built consistency node vs. an unset one.)
    buildDefaultConfig: () => ({ members: 5 }),
  },
  critic: {
    type: "critic",
    label: "Critic Loop",
    blurb: "Generate → critique → revise until it passes.",
    advancedAllowed: true,
    buildDefaultConfig: (verifyCmd) => ({
      maxIters: 3,
      passThreshold: 75,
      ...(verifyCmd ? { verifyCmd } : {}),
    }),
  },
  cascade: {
    type: "cascade",
    label: "Cascade",
    blurb: "Cheap model first; escalate to a stronger one if weak.",
    advancedAllowed: true,
    buildDefaultConfig: (verifyCmd) => ({
      passThreshold: 75,
      escalateModel: null,
      escalateBackend: null,
      ...(verifyCmd ? { verifyCmd } : {}),
    }),
  },
  router: {
    type: "router",
    label: "Router",
    blurb: "Classify the task → run the best-fit model/role.",
    advancedAllowed: false,
    buildDefaultConfig: () => null,
  },
  blackboard: {
    type: "blackboard",
    label: "Blackboard",
    blurb: "Summarize / snapshot / clear shared run memory.",
    advancedAllowed: false,
    buildDefaultConfig: () => null,
  },
  budget: {
    type: "budget",
    label: "Budget",
    blurb: "Run under a token/time ceiling; return best effort.",
    advancedAllowed: false,
    buildDefaultConfig: () => null,
  },
  parallel: {
    type: "parallel",
    label: "Parallel",
    blurb: "Run independent branches at once → collected results.",
    // Excluded from create_flow ADVANCED mode (like router/blackboard/budget):
    // its branches need structured config (an explicit branch-prompt list) the
    // high-level step shape can't express, and the registry parity test pins
    // the advanced set to {agent, moa, consistency, critic, cascade}.
    advancedAllowed: false,
    // Fan-out carries no aggregation config; a bare card defaults to `members`
    // (3) identical branches at runtime. Return null so an advanced-built card
    // (were it ever allowed) stays lean — matches router/blackboard/budget.
    buildDefaultConfig: () => null,
  },
};
