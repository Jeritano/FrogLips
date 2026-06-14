/* ── consistency node (self-consistency) ────────────────────────────────────
 *
 * Sample the same prompt N times, then vote or merge. Body moved VERBATIM from
 * the old `nodes.ts` `runConsistency`.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { NODE_META } from "./metadata";
import {
  coerceBackend,
  errMsg,
  majorityVote,
  runSub,
  sampleTemperature,
  taskText,
} from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. */
export type ConsistencyConfig = Pick<
  WorkflowNodeConfig,
  "members" | "voteMode" | "synthPrompt" | "synthModel" | "synthBackend"
>;

/** Self-consistency: sample the same prompt N times, then vote or merge. */
export async function runConsistency(ctx: NodeRunContext): Promise<string> {
  const cfg: ConsistencyConfig = ctx.card.nodeConfig ?? {};
  const n = cfg.members ?? 5;
  const mode = cfg.voteMode ?? "synth";
  const task = taskText(ctx.base);
  if (ctx.signal.aborted) return "";
  ctx.emit(`Self-consistency — ${n} samples…\n`);
  // Vary the sampling temperature per member (index-derived, deterministic) so
  // the N samples are genuinely independent draws — otherwise they collapse to
  // near-identical text and the consistency vote has nothing to weigh.
  const samples = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runSub(ctx, {
        stream: false,
        temperature: sampleTemperature(i, n),
      }).catch((e) => `[sample ${i + 1} failed: ${errMsg(e)}]`),
    ),
  );
  if (ctx.signal.aborted) return samples.find(Boolean) ?? "";
  // "vote" → a real tally: if ≥2 samples produce the same answer, return the
  // modal one verbatim (cheap, no extra LLM call). Only fall back to a synthesis
  // pass when there's no agreement.
  if (mode === "vote") {
    const winner = majorityVote(samples);
    if (winner) {
      ctx.emit(`Majority vote: ${winner.agree}/${n} agree.\n\n`);
      return winner.answer;
    }
    ctx.emit(`No majority — synthesizing instead.\n\n`);
  } else {
    ctx.emit(`Merging ${n} samples…\n\n`);
  }
  const block = samples.map((s, i) => `### Sample ${i + 1}\n${s}`).join("\n\n");
  const instr =
    mode === "vote"
      ? "Below are independent samples answering the SAME task. Determine the answer the MAJORITY of samples agree on and return that consensus answer (lightly cleaned up). If there is no clear majority, return the most defensible single answer."
      : (cfg.synthPrompt ??
        "Merge these independent samples into the single most self-consistent answer, keeping only conclusions that most samples agree on.");
  const userContent = `${instr}\n\n## Task\n${task}\n\n## Samples\n${block}\n\n## Final answer:`;
  return runSub(ctx, {
    userContent,
    model: cfg.synthModel,
    backend: coerceBackend(cfg.synthBackend),
    stream: true,
  });
}

export const consistencyHandler: NodeHandler = {
  ...NODE_META.consistency,
  run: runConsistency,
};
