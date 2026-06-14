/* ── cascade node ───────────────────────────────────────────────────────────
 *
 * Cheap/local model first; escalate to a stronger model if it scores low. Body
 * moved VERBATIM from the old `nodes.ts` `runCascade`.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { NODE_META } from "./metadata";
import { coerceBackend, parseScore, runSub, taskText } from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. */
export type CascadeConfig = Pick<
  WorkflowNodeConfig,
  | "passThreshold"
  | "criticPrompt"
  | "criticModel"
  | "criticBackend"
  | "escalateModel"
  | "escalateBackend"
  | "verifyCmd"
>;

/** Cascade: cheap/local model first; escalate to a stronger model if it scores low. */
export async function runCascade(ctx: NodeRunContext): Promise<string> {
  const cfg: CascadeConfig = ctx.card.nodeConfig ?? {};
  const threshold = cfg.passThreshold ?? 70;
  const task = taskText(ctx.base);
  ctx.emit(`Cascade — trying base model (${ctx.base.model})…\n`);
  const baseAns = await runSub(ctx, { stream: true });
  if (ctx.signal.aborted || !cfg.escalateModel) return baseAns;
  const scoreInstr =
    cfg.criticPrompt ??
    "Score 0-100 how well this answer solves the task. Reply with only 'SCORE: <number>' followed by one short reason.";
  const critique = await runSub(ctx, {
    userContent: `${scoreInstr}\n\n## Task\n${task}\n\n## Answer\n${baseAns}`,
    model: cfg.criticModel,
    backend: coerceBackend(cfg.criticBackend),
    stream: false,
  });
  const score = parseScore(critique);
  ctx.emit(`\nBase score ${score ?? "?"} / ${threshold} escalation mark\n`);
  if (score != null && score >= threshold) return baseAns;
  ctx.emit(`Escalating to ${cfg.escalateModel}…\n`);
  // Refine, don't restart: hand the stronger model the base draft + why it fell
  // short (the critique) so it builds on the cheap pass instead of re-solving
  // from scratch. Mirrors the critic loop's revise prompt.
  return runSub(ctx, {
    userContent: `A cheaper model produced the draft below; a critic judged it insufficient. Produce a better, correct, and complete answer — fix the problems the critique raises rather than starting over. Output ONLY the improved answer.\n\n## Task\n${task}\n\n## Previous draft\n${baseAns}\n\n## Critique\n${critique}`,
    model: cfg.escalateModel,
    backend: coerceBackend(cfg.escalateBackend),
    stream: true,
  });
}

export const cascadeHandler: NodeHandler = {
  ...NODE_META.cascade,
  run: runCascade,
};
