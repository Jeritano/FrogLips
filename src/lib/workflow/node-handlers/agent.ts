/* ── agent node ─────────────────────────────────────────────────────────────
 *
 * The default node type: one streamed `runAgentLoop` pass. No orchestration
 * config (`buildDefaultConfig` returns null). This is the same body the old
 * `dispatchNode` default branch ran.
 */

import { NODE_META } from "./metadata";
import { runSub } from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

export async function runAgent(ctx: NodeRunContext): Promise<string> {
  return runSub(ctx, { stream: true });
}

export const agentHandler: NodeHandler = {
  ...NODE_META.agent,
  run: runAgent,
};
