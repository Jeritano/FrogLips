/* ── router node ────────────────────────────────────────────────────────────
 *
 * Classify the task → run the best-fit route (model/backend/preset). Body moved
 * VERBATIM from the old `nodes.ts` `runRouter`. router/blackboard/budget are
 * NOT advanced-authorable (they need structured config the high-level step shape
 * can't express) — `advancedAllowed:false`.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { NODE_META } from "./metadata";
import {
  coerceBackend,
  parseRouteIndex,
  runSub,
  taskText,
} from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. */
export type RouterConfig = Pick<
  WorkflowNodeConfig,
  "routes" | "routerModel" | "routerBackend"
>;

/** Router: classify the task → run the best-fit route (model/backend/preset). */
export async function runRouter(ctx: NodeRunContext): Promise<string> {
  const cfg: RouterConfig = ctx.card.nodeConfig ?? {};
  const routes = cfg.routes ?? [];
  const task = taskText(ctx.base);
  if (routes.length === 0) return runSub(ctx, { stream: true });
  const list = routes
    .map((r, i) => `${i + 1}. [${r.label}] ${r.when}`)
    .join("\n");
  const decision = await runSub(ctx, {
    userContent: `You are a routing classifier. Choose the single best-fit route for the task. End your reply with exactly 'ROUTE: <number>'.\n\n## Task\n${task}\n\n## Routes\n${list}\n\n## Best route (end with ROUTE: <number>):`,
    model: cfg.routerModel,
    backend: coerceBackend(cfg.routerBackend),
    stream: false,
  });
  const chosen = routes[parseRouteIndex(decision, routes.length)] ?? routes[0];
  ctx.emit(`Routed → [${chosen.label}]\n`);
  const preset = chosen.preset
    ? ctx.presets.find((p) => p.id === chosen.preset)
    : undefined;
  return runSub(ctx, {
    model: chosen.model,
    backend: coerceBackend(chosen.backend),
    systemPromptOverride: preset?.systemPromptOverride,
    toolAllowlist: preset?.allowedTools,
    stream: true,
  });
}

export const routerHandler: NodeHandler = {
  ...NODE_META.router,
  run: runRouter,
};
