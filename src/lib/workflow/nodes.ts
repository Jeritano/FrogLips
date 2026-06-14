/**
 * Workflow orchestration node dispatch (thin facade).
 *
 * A workflow card whose `nodeType` is anything other than `"agent"` is an
 * ORCHESTRATOR: instead of one `runAgentLoop` pass it fans out, loops, votes,
 * or escalates a set of sub-runs. Every sub-run still goes through the same
 * `runAgentLoop` (so tools / MCP / approval gates / streaming all work), which
 * means these handlers compose on top of the existing engine with zero changes
 * to the backend layer.
 *
 * Each node type now lives in its own self-contained module under
 * `node-handlers/`, registered in `node-handlers/registry.ts`. This file stays
 * thin: it resolves a card to its handler via the registry, applies the
 * universal budget wrapper, and re-exports the shared helpers + the
 * `NodeRunContext` type for back-compat with existing importers.
 *
 * Backend note: `runAgentLoop` supports `ollama | mlx | native` (local /
 * in-process) AND `custom | openrouter` (OpenAI-compatible cloud) for the
 * tool-calling loop. The "cloud tier" inside a flow can be an Ollama `:cloud`
 * model id on the `ollama` backend OR a `custom`/`openrouter` backend override
 * (see `coerceBackend` in `node-handlers/shared.ts`). An unsupported backend
 * string falls back to the card backend.
 *
 * Confidence: no logprobs are exposed by any backend, so "confidence" for the
 * critic/cascade nodes is a separate critic-model scoring pass (`SCORE: <n>`),
 * not a token-probability signal.
 */

import type { WorkflowCard } from "../../types";
import type { AgentRunOptions } from "../agent-loop/types";
import { handlerFor } from "./node-handlers/registry";
import { budgetLimits, withBudgetCeiling } from "./node-handlers/shared";
import type { NodeRunContext } from "./node-handlers/types";

// ── Re-exports for back-compat ───────────────────────────────────────────────
// `NodeRunContext` is imported by the runner-adjacent code + tests; the shared
// helpers (`runSub`, `coerceBackend`, `parseScore`, `voteKey`, `taskText`,
// `withBudgetCeiling`, …) were public from this module historically.
export type { NodeRunContext } from "./node-handlers/types";
export {
  coerceBackend,
  parseScore,
  parseRouteIndex,
  voteKey,
  majorityVote,
  normalizeAnswer,
  structuredKey,
  sampleTemperature,
  taskText,
  systemMessages,
  errMsg,
  runSub,
  withBudgetCeiling,
  budgetLimits,
} from "./node-handlers/shared";
export type { SubOpts, BudgetInner } from "./node-handlers/shared";

/** True when a card needs the orchestrator dispatch rather than a plain agent pass. */
export function isOrchestratorNode(card: WorkflowCard): boolean {
  return !!card.nodeType && card.nodeType !== "agent";
}

/** True when the card carries card-level budget ceilings. Budget is universal
 *  (Wave 1): EVERY node type — including a plain "agent" card — honors
 *  `nodeConfig.maxTokens` / `nodeConfig.maxMs`. The runner routes any card
 *  that returns true here through {@link runWorkflowNode} so the
 *  `runUnderBudget` wrapper applies; absent limits keep the legacy
 *  no-ceiling behavior. */
export function hasCardBudget(card: WorkflowCard): boolean {
  return card.nodeConfig?.maxTokens != null || card.nodeConfig?.maxMs != null;
}

/** Inner dispatch — resolve the card's handler from the registry and run it,
 *  without budget wrapping. An absent/unknown node type falls back to the plain
 *  `agent` handler (matches the legacy default branch). */
export function dispatchNode(ctx: NodeRunContext): Promise<string> {
  return handlerFor(ctx.card.nodeType).run(ctx);
}

/**
 * Universal budget wrapper: enforce card-level `maxTokens` / `maxMs` ceilings
 * around ANY node handler. Mirrors the `budget` node's semantics — child abort
 * controller for the time ceiling, `onExceed` "best" returns the partial,
 * "stop" throws — but generalized:
 *   - the token ceiling rides on the base params so EVERY sub-run the handler
 *     fans out inherits it (a per-call cap, not an aggregate),
 *   - the time ceiling aborts the child signal, which every handler already
 *     checks between iterations/fan-outs,
 *   - "best effort" is the handler's own return when it survived the abort
 *     (e.g. the critic's current draft), else the text streamed so far. The
 *     stream buffer includes the handler's status lines — acceptable for a
 *     partial that exists only because the ceiling fired.
 */
async function runUnderBudget(
  ctx: NodeRunContext,
  inner: (c: NodeRunContext) => Promise<string>,
): Promise<string> {
  const cfg = ctx.card.nodeConfig ?? {};
  const limits = budgetLimits(cfg);
  ctx.emit(`Budget ceiling (${limits.join(", ")})…\n`);
  const base: AgentRunOptions =
    cfg.maxTokens != null
      ? {
          ...ctx.base,
          params: {
            ...(ctx.base.params ?? {}),
            // Card param max_tokens may already be tighter — keep the min.
            max_tokens: Math.min(
              ctx.base.params?.max_tokens ?? Number.POSITIVE_INFINITY,
              cfg.maxTokens,
            ),
          },
        }
      : ctx.base;
  return withBudgetCeiling(ctx, ({ signal, emit }) =>
    inner({
      ...ctx,
      base: { ...base, signal },
      signal,
      emit,
    }),
  );
}

/** Dispatch a card to its orchestration handler under the universal budget.
 *  Called for every orchestrator card AND for plain "agent" cards that carry
 *  budget ceilings ({@link hasCardBudget}); the `"agent"` default branch is a
 *  single streamed pass. The dedicated `budget` node already arms the ceiling
 *  itself (it shares {@link withBudgetCeiling} with the wrapper) — skip the
 *  wrapper there so the controller/timer isn't armed twice. */
export function runWorkflowNode(ctx: NodeRunContext): Promise<string> {
  if (ctx.card.nodeType !== "budget" && hasCardBudget(ctx.card)) {
    return runUnderBudget(ctx, dispatchNode);
  }
  return dispatchNode(ctx);
}
