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

/** Order-insensitive equality of two tool allowlists. */
function toolsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const sa = [...(a ?? [])].sort();
  const sb = [...(b ?? [])].sort();
  return sa.length === sb.length && sa.every((t, i) => t === sb[i]);
}

/**
 * True when `saved` is a clone of `template`: same card count AND same set of
 * card ids. We match on the id SET — NOT on prompt equality — deliberately.
 *
 * The first cut keyed on identical prompts, which was self-defeating: the
 * moment a template's prompt wording is improved (e.g. the v0.13.2 path-
 * discipline block added to the Implementer), every previously-saved clone
 * stops matching its own template and never heals — exactly the OLD clones
 * that most need it. The card-id set is the stable identity of a template
 * (`fc1..fc5`, `bh1..bh4`); a user keeps those ids across edits. Customization
 * is instead detected per-FIELD inside `syncCard`, which only heals the two
 * things a stale clone has provably wrong and never overwrites a deliberate
 * edit.
 */
function isTemplateClone(saved: Workflow, tplCards: WorkflowCard[]): boolean {
  const savedCards = saved.graph.cards;
  if (savedCards.length !== tplCards.length) return false;
  const tplIds = new Set(tplCards.map((c) => c.id));
  // Sizes equal + every saved id present in the template ⇒ identical id sets.
  return savedCards.every((sc) => tplIds.has(sc.id));
}

/**
 * Heal ONLY the two fields a stale pre-v0.13.1 clone has provably wrong, and
 * only when doing so can't clobber a deliberate user edit:
 *
 *   1. `unattended` — re-arm an action card that the current template ships
 *      armed, BUT only if the saved card's tool allowlist is UNCHANGED from
 *      the template. If the user altered the tools, they customized the card —
 *      leave its arm state alone.
 *   2. `verifyCmd` — swap the exact known-stale literal `"npm test"` for the
 *      template's safe auto-detecting command. A user's own custom verify
 *      command (anything other than that literal) is never touched.
 *
 * Everything else — prompt, name, preset, tools, position, schedule, model,
 * the rest of nodeConfig — stays exactly as saved.
 */
function syncCard(
  saved: WorkflowCard,
  tpl: WorkflowCard,
): { card: WorkflowCard; changed: boolean } {
  let next = saved;
  let changed = false;

  // 1. Re-arm an unmodified-tools action card the template ships armed.
  if (
    tpl.unattended === true &&
    saved.unattended !== true &&
    toolsEqual(saved.tools, tpl.tools)
  ) {
    next = { ...next, unattended: true };
    changed = true;
  }

  // 2. Replace the known-stale verify literal with the template's safe one.
  const savedVerify = saved.nodeConfig?.verifyCmd;
  const tplVerify = tpl.nodeConfig?.verifyCmd;
  if (savedVerify === "npm test" && tplVerify && tplVerify !== "npm test") {
    next = {
      ...next,
      nodeConfig: { ...next.nodeConfig, verifyCmd: tplVerify },
    };
    changed = true;
  }

  return { card: next, changed };
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
      isTemplateClone(wf, cards),
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
