/* ── moa node (Mixture-of-Agents) ───────────────────────────────────────────
 *
 * N proposers in parallel → one synthesis pass. Body moved VERBATIM from the
 * old `nodes.ts` `runMoa`.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { NODE_META } from "./metadata";
import {
  coerceBackend,
  errMsg,
  runSub,
  sampleTemperature,
  taskText,
} from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. No
 *  runtime conversion — `nodeConfig` is the same flat bag persisted in
 *  `graph_json`; this Pick only documents/types the subset moa touches. */
export type MoaConfig = Pick<
  WorkflowNodeConfig,
  "members" | "synthPrompt" | "synthModel" | "synthBackend"
>;

const DEFAULT_SYNTH =
  "You are an expert aggregator. Read the independent proposals below and produce the single best, correct, and complete answer. Resolve disagreements by reasoning about which is right — do not merely concatenate them.";

/** Mixture-of-Agents: N proposers in parallel → one synthesis pass. */
export async function runMoa(ctx: NodeRunContext): Promise<string> {
  const cfg: MoaConfig = ctx.card.nodeConfig ?? {};
  const n = cfg.members ?? 3;
  const task = taskText(ctx.base);
  if (ctx.signal.aborted) return "";
  ctx.emit(`Mixture-of-Agents — ${n} proposers running in parallel…\n`);
  // Vary the sampling temperature per proposer (index-derived, deterministic) so
  // the N drafts genuinely diverge — otherwise they collapse to near-identical
  // text and the synthesis pass has nothing independent to reconcile. Same fix
  // and helper as runConsistency so the two nodes can't drift.
  const proposals = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runSub(ctx, { stream: false, temperature: sampleTemperature(i, n) }).catch(
        (e) => `[proposer ${i + 1} failed: ${errMsg(e)}]`,
      ),
    ),
  );
  if (ctx.signal.aborted) return proposals.find(Boolean) ?? "";
  ctx.emit(`\nSynthesizing ${n} proposals…\n\n`);
  const block = proposals
    .map((p, i) => `### Proposal ${i + 1}\n${p}`)
    .join("\n\n");
  const instr = cfg.synthPrompt ?? DEFAULT_SYNTH;
  const userContent = `${instr}\n\n## Task\n${task}\n\n## Proposals\n${block}\n\n## Your single best answer:`;
  return runSub(ctx, {
    userContent,
    model: cfg.synthModel,
    backend: coerceBackend(cfg.synthBackend),
    stream: true,
  });
}

export const moaHandler: NodeHandler = {
  ...NODE_META.moa,
  run: runMoa,
};
