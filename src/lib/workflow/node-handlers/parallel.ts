/* ── parallel node (fan-out) ────────────────────────────────────────────────
 *
 * Run several INDEPENDENT branches concurrently, then collect their results
 * into one labeled block. Unlike `moa` (which synthesizes the proposals into a
 * single answer) and `consistency` (which votes/merges samples of the SAME
 * task), the parallel node does NO aggregation pass — it returns every branch's
 * output verbatim under a `### Branch N` heading so a downstream card (or the
 * user) can consume them all. This is the cheap fan-out primitive: N things
 * that don't depend on each other, run at once, results concatenated.
 *
 * Two ways to define the branches:
 *   - `branchPrompts` (preferred): an explicit list of per-branch tasks. Each
 *     entry replaces the card's user message for that branch, so the branches
 *     can ask genuinely different things ("summarize", "list risks", "draft a
 *     reply"). The card's system prompt / persona / tools are shared.
 *   - else `members` (fallback): N identical passes of the card task (same shape
 *     as moa's proposers, temperature-spread so the runs diverge). Useful when
 *     you just want N independent attempts without an aggregation step.
 *
 * Concurrency is BOUNDED (reusing the shared `runWithConcurrency` helper) so a
 * large fan-out can't open an unbounded number of in-flight model calls at once
 * — the same caution moa/consistency lack, applied here where the branch count
 * is the most directly user-controlled. The budget/abort/gate semantics are
 * unchanged: every branch goes through `runSub`, which threads the (possibly
 * budget-narrowed) base params + the run's abort signal, and the universal
 * budget wrapper in `nodes.ts` still arms the ceiling around this handler.
 */

import type { WorkflowNodeConfig } from "../../../types";
import { runWithConcurrency } from "../../agent-loop/runner-helpers";
import { NODE_META } from "./metadata";
import { errMsg, runSub, sampleTemperature } from "./shared";
import type { NodeHandler, NodeRunContext } from "./types";

/** Compile-time structural view of the config fields this handler reads. No
 *  runtime conversion — `nodeConfig` is the same flat bag persisted in
 *  `graph_json`; this Pick only documents/types the subset parallel touches. */
export type ParallelConfig = Pick<
  WorkflowNodeConfig,
  "members" | "branchPrompts"
>;

/** Cap on concurrently in-flight branches. The branch COUNT is already clamped
 *  (members 2..8 in normalizeNodeConfig; branchPrompts sliced to 8 there), so
 *  this is a soft ceiling on RAM/KV-cache pressure rather than a correctness
 *  bound — same-model fan-out shares one loaded model, only the KV cache grows
 *  per concurrent request. */
const MAX_IN_FLIGHT = 4;

/** Resolve the ordered branch task list. Explicit `branchPrompts` win (trimmed,
 *  blanks dropped); otherwise fall back to `members` identical passes of the
 *  card task. Defaults to 3 identical branches — matches moa's proposer default
 *  so an un-configured parallel card still fans out meaningfully. */
function resolveBranches(cfg: ParallelConfig): {
  /** Per-branch user message override, or null to reuse the card prompt verbatim. */
  prompt: string | null;
}[] {
  const explicit = (cfg.branchPrompts ?? [])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  if (explicit.length > 0) {
    return explicit.map((prompt) => ({ prompt }));
  }
  const n = cfg.members ?? 3;
  return Array.from({ length: n }, () => ({ prompt: null }));
}

/** Parallel fan-out: run N independent branches concurrently → labeled block. */
export async function runParallel(ctx: NodeRunContext): Promise<string> {
  const cfg: ParallelConfig = ctx.card.nodeConfig ?? {};
  const branches = resolveBranches(cfg);
  const n = branches.length;
  if (ctx.signal.aborted || n === 0) return "";
  ctx.emit(`Parallel fan-out — ${n} branches running concurrently…\n`);

  // Pre-size the results array so each branch writes its own slot — the
  // bounded runner does NOT preserve completion order, but we want the OUTPUT
  // ordered by branch index for a stable, labeled block.
  const results: string[] = new Array(n).fill("");
  const tasks = branches.map((b, i) => async () => {
    // Hidden sub-runs (stream:false): the live card output is the collected
    // block below, not the interleaved deltas of N concurrent branches (which
    // would arrive jumbled). Vary the temperature per branch when the branches
    // are identical passes so they genuinely diverge (same helper + rationale
    // as moa/consistency); explicit-prompt branches already differ by prompt so
    // they keep the card's sampling.
    const temperature =
      b.prompt == null ? sampleTemperature(i, n) : undefined;
    try {
      results[i] = await runSub(ctx, {
        userContent: b.prompt ?? undefined,
        stream: false,
        temperature,
      });
    } catch (e) {
      results[i] = `[branch ${i + 1} failed: ${errMsg(e)}]`;
    }
  });
  await runWithConcurrency(tasks, MAX_IN_FLIGHT);

  if (ctx.signal.aborted) return results.find(Boolean) ?? "";
  ctx.emit(`\nCollected ${n} branches.\n\n`);
  // Concatenate verbatim under per-branch headings — NO synthesis pass. Label
  // with the explicit prompt's first line when present so the block is readable
  // ("### Branch 1 — summarize the doc"); fall back to a bare index otherwise.
  return branches
    .map((b, i) => {
      const label = b.prompt
        ? `### Branch ${i + 1} — ${b.prompt.split(/\r?\n/)[0].slice(0, 80)}`
        : `### Branch ${i + 1}`;
      return `${label}\n${results[i]}`;
    })
    .join("\n\n");
}

export const parallelHandler: NodeHandler = {
  ...NODE_META.parallel,
  run: runParallel,
};
