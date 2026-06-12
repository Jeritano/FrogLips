/* ── Stale template-clone healing ────────────────────────────────────────────
 *
 * A demo exposed a sharp edge: workflows cloned from a FLOW_TEMPLATE *before*
 * the v0.13.1 fix froze the old, broken config — action cards shipped with
 * `unattended:false` (so write_file/run_shell silently hit the runner's
 * deny-all gate and the flow produced NOTHING) and a `verifyCmd` of `"npm
 * test"` (exit 254 on a project with no npm → the critic looped). New clones
 * are fine; the stale ones already sitting in the user's DB are not.
 *
 * `healStaleTemplateClones` re-syncs the *execution* config of an UNMODIFIED
 * clone from its source template. "Unmodified" is strict: a saved workflow is
 * only healed when a template's graph STRUCTURALLY MATCHES it — same set of
 * card ids AND identical card prompts. The moment any prompt differs, the
 * workflow is treated as user-customized and is returned untouched (we must
 * never overwrite a deliberate edit). The user's name/preset/position/schedule
 * always stay as saved; only the safety-critical execution fields the template
 * owns — `unattended`, `nodeConfig` (incl. verifyCmd), and `tools` — are
 * copied back.
 *
 * Pure function, no IO. The caller (WorkflowsPage) persists the changed ones
 * via the normal save API. Idempotent: a workflow already healed structurally
 * still matches its template, but every healed field now equals the template's,
 * so a second pass reports `changed:false`.
 */

import type { Workflow, WorkflowCard } from "../../types";
import { parseWorkflow, serializeWorkflowGraph } from "../../types";
import { FLOW_TEMPLATES } from "./templates";

export interface HealResult {
  workflow: Workflow;
  changed: boolean;
}

/**
 * A template's graph, NORMALIZED through the same `parseWorkflow` path a saved
 * workflow goes through on load. Saved cards are compared/written against THIS,
 * not the raw template literal: `normalizeNodeConfig` clamps + key-orders the
 * `nodeConfig` object deterministically, so a pristine clone round-tripped
 * through the DB (and thus key-reordered) still compares equal to its template
 * here. Without this, a pristine clone would JSON-differ from the raw template
 * on every load and be needlessly re-saved — breaking idempotency. Normalizing
 * the templates ONCE at module load keeps the per-load heal cheap.
 *
 * Built via `parseWorkflow(serialize(...))` rather than calling the
 * (non-exported) `normalizeNodeConfig` directly so heal stays coupled to the
 * exact load-path normalization, whatever it becomes.
 */
const NORMALIZED_TEMPLATE_CARDS: WorkflowCard[][] = FLOW_TEMPLATES.map(
  (t) =>
    parseWorkflow({
      id: 0,
      name: t.name,
      graph_json: serializeWorkflowGraph(t.graph),
      created_at: 0,
      updated_at: 0,
    }).graph.cards,
);

/**
 * True when `saved` is an UNMODIFIED clone of `template`: the exact same set of
 * card ids and, for every card, an identical prompt. Edge topology and card
 * count fall out of the id-set check (a clone shares both), and prompts are the
 * field a user is most likely to edit — diverge on any prompt and we treat the
 * whole workflow as customized. We deliberately do NOT compare the execution
 * fields here (unattended/nodeConfig/tools): those are exactly what a stale
 * clone has WRONG, so requiring them to match would make every stale clone fail
 * to match its own template and never get healed.
 */
function isUnmodifiedClone(saved: Workflow, tplCards: WorkflowCard[]): boolean {
  const savedCards = saved.graph.cards;
  if (savedCards.length !== tplCards.length) return false;

  const tplById = new Map(tplCards.map((c) => [c.id, c]));
  // Same id SET (sizes already equal, so a one-to-one cover proves equality).
  for (const sc of savedCards) {
    const tc = tplById.get(sc.id);
    if (!tc) return false;
    if (sc.prompt !== tc.prompt) return false;
  }
  return true;
}

/**
 * Re-sync a single saved card's execution config from its template card.
 * Returns the (possibly new) card and whether anything actually changed. The
 * change check is on the JSON of the synced fields so a re-heal of an
 * already-healed card reports no change (idempotency).
 */
function syncCard(
  saved: WorkflowCard,
  tpl: WorkflowCard,
): { card: WorkflowCard; changed: boolean } {
  // Normalize for comparison: the template's `card()` factory always sets
  // `unattended` (default false) and `tools` ([]), but `nodeConfig` is only
  // present when the template states one. Treat absent as the canonical empty.
  const tplUnattended = tpl.unattended === true;
  const tplTools = tpl.tools ?? [];
  const tplNodeConfig = tpl.nodeConfig ?? null;

  const before = JSON.stringify({
    unattended: saved.unattended === true,
    tools: saved.tools ?? [],
    nodeConfig: saved.nodeConfig ?? null,
  });
  const after = JSON.stringify({
    unattended: tplUnattended,
    tools: tplTools,
    nodeConfig: tplNodeConfig,
  });
  if (before === after) return { card: saved, changed: false };

  // Copy the template's execution fields onto a clone of the saved card;
  // everything else (name/preset/prompt/position/schedule/model/backend/…)
  // stays as the user saved it. Deep-copy the template's tools + nodeConfig so
  // the healed workflow can never alias the shared template object.
  const card: WorkflowCard = {
    ...saved,
    unattended: tplUnattended,
    tools: [...tplTools],
    nodeConfig: tplNodeConfig
      ? (JSON.parse(
          JSON.stringify(tplNodeConfig),
        ) as WorkflowCard["nodeConfig"])
      : null,
  };
  return { card, changed: true };
}

/**
 * Heal every stale, UNMODIFIED template clone in `savedWorkflows`. Each input
 * workflow yields a {workflow, changed} pair: `changed:true` workflows carry a
 * re-synced graph the caller should persist; everything else (no matching
 * template, a user-customized clone, or an already-healed one) is returned
 * unchanged with `changed:false`.
 */
export function healStaleTemplateClones(
  savedWorkflows: Workflow[],
): HealResult[] {
  return savedWorkflows.map((wf) => {
    const tplCards = NORMALIZED_TEMPLATE_CARDS.find((cards) =>
      isUnmodifiedClone(wf, cards),
    );
    if (!tplCards) return { workflow: wf, changed: false };

    const tplById = new Map(tplCards.map((c) => [c.id, c]));
    let changed = false;
    const cards = wf.graph.cards.map((sc) => {
      const tc = tplById.get(sc.id);
      // tc is always present (isUnmodifiedClone proved the id-set cover), but
      // guard anyway so a future loosening of the match can't crash here.
      if (!tc) return sc;
      const synced = syncCard(sc, tc);
      if (synced.changed) changed = true;
      return synced.card;
    });

    if (!changed) return { workflow: wf, changed: false };
    return {
      workflow: { ...wf, graph: { ...wf.graph, cards } },
      changed: true,
    };
  });
}
