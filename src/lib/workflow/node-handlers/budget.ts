/* ── budget node ────────────────────────────────────────────────────────────
 *
 * Run a single base-agent pass under a token and/or wall-clock ceiling. Shares
 * all ceiling machinery with the universal wrapper via {@link withBudgetCeiling}
 * — the only node-specific part is the body (one streamed `runSub` capped at
 * `maxTokens`). Body moved VERBATIM from the old `nodes.ts` `runBudget`. Not
 * advanced-authorable.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { NODE_META } from "./metadata";
import { budgetLimits, runSub, withBudgetCeiling } from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. */
export type BudgetConfig = Pick<
  WorkflowNodeConfig,
  "maxTokens" | "maxMs" | "onExceed"
>;

/** Budget node: run a single base-agent pass under a token and/or wall-clock
 *  ceiling. */
export async function runBudget(ctx: NodeRunContext): Promise<string> {
  const cfg: BudgetConfig = ctx.card.nodeConfig ?? {};
  const limits = budgetLimits(cfg);
  ctx.emit(`Budget run${limits.length ? ` (${limits.join(", ")})` : ""}…\n`);
  return withBudgetCeiling(ctx, ({ signal, emit }) =>
    runSub(ctx, {
      stream: true,
      maxTokens: cfg.maxTokens ?? undefined,
      signal,
      onDelta: emit,
    }),
  );
}

export const budgetHandler: NodeHandler = {
  ...NODE_META.budget,
  run: runBudget,
};
