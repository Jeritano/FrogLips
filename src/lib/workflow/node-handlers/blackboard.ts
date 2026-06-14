/* ── blackboard node ────────────────────────────────────────────────────────
 *
 * Operate on the shared run scratchpad (snapshot / summarize / clear). Body
 * moved VERBATIM from the old `nodes.ts` `runBlackboard`. Not advanced-authorable.
 */

import type { WorkflowNodeConfig } from "../../../types";
import {
  clearAll as scratchpadClear,
  snapshot as scratchpadSnapshot,
} from "../scratchpad";
import { NODE_META } from "./metadata";
import { runSub, taskText } from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. */
export type BlackboardConfig = Pick<WorkflowNodeConfig, "blackboardOp">;

/** Blackboard: operate on the shared run scratchpad (snapshot / summarize / clear). */
export async function runBlackboard(ctx: NodeRunContext): Promise<string> {
  const cfg: BlackboardConfig = ctx.card.nodeConfig ?? {};
  const op = cfg.blackboardOp ?? "snapshot";
  const snap = scratchpadSnapshot();
  const entries = snap?.entries ?? {};
  const json = JSON.stringify(entries, null, 2);
  if (op === "clear") {
    scratchpadClear();
    ctx.emit(`Blackboard cleared.\n`);
    return "Blackboard cleared.";
  }
  if (op === "snapshot") {
    const body = Object.keys(entries).length
      ? "```json\n" + json + "\n```"
      : "Blackboard is empty.";
    ctx.emit(`Blackboard snapshot:\n${body}\n`);
    return body;
  }
  // summarize
  const task = taskText(ctx.base);
  ctx.emit(`Summarizing shared blackboard…\n`);
  return runSub(ctx, {
    userContent: `Summarize the shared workflow state below into a concise briefing for the next agent.${task ? `\n\n## Focus\n${task}` : ""}\n\n## Shared state (JSON)\n${json}`,
    stream: true,
  });
}

export const blackboardHandler: NodeHandler = {
  ...NODE_META.blackboard,
  run: runBlackboard,
};
