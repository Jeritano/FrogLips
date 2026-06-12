import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowGraph } from "../../../types";
import { parseWorkflow, serializeWorkflowGraph } from "../../../types";
import { healStaleTemplateClones } from "../heal-templates";
import { FLOW_TEMPLATES, cloneTemplateGraph } from "../templates";

/**
 * Wrap a graph in a saved-workflow envelope EXACTLY as the load path produces
 * it: serialized to graph_json then re-parsed through `parseWorkflow`. This
 * applies the same `normalizeNodeConfig` clamp + key-ordering a real DB-loaded
 * workflow carries — the heal compares against that normalized shape, so the
 * fixtures must too (otherwise a pristine clone would falsely look "changed"
 * on a raw-key-ordered object the load path never actually yields).
 */
function wf(id: number, name: string, graph: WorkflowGraph): Workflow {
  return parseWorkflow({
    id,
    name,
    graph_json: serializeWorkflowGraph(graph),
    created_at: 0,
    updated_at: 0,
  });
}

/** The feature-crew template — its Implementer (fc3) is an action card the v0.13.1 fix armed. */
const FEATURE_CREW = FLOW_TEMPLATES.find((t) => t.id === "feature-crew")!;

/**
 * Produce a STALE clone of a template: structurally identical (same card ids
 * + prompts) but with the pre-v0.13.1 frozen execution config — every action
 * card de-armed (`unattended:false`) and any `verifyCmd` reverted to the old
 * `"npm test"` literal that exited 254 and looped the critic.
 */
function staleClone(id: number, name: string, templateId: string): Workflow {
  const t = FLOW_TEMPLATES.find((x) => x.id === templateId)!;
  const graph = cloneTemplateGraph(t);
  for (const c of graph.cards) {
    c.unattended = false;
    if (c.nodeConfig?.verifyCmd) {
      c.nodeConfig = { ...c.nodeConfig, verifyCmd: "npm test" };
    }
  }
  return wf(id, name, graph);
}

describe("healStaleTemplateClones", () => {
  it("heals an unmodified stale clone back to the template execution config", () => {
    const stale = staleClone(1, "Feature Crew", "feature-crew");

    // Sanity: the clone really is stale before healing.
    const fc3Before = stale.graph.cards.find((c) => c.id === "fc3")!;
    expect(fc3Before.unattended).toBe(false);
    expect(fc3Before.nodeConfig?.verifyCmd).toBe("npm test");

    const [res] = healStaleTemplateClones([stale]);
    expect(res.changed).toBe(true);

    const tplById = new Map(FEATURE_CREW.graph.cards.map((c) => [c.id, c]));
    for (const card of res.workflow.graph.cards) {
      const tpl = tplById.get(card.id)!;
      // Execution fields re-synced from the template…
      expect(card.unattended === true).toBe(tpl.unattended === true);
      expect(card.tools).toEqual(tpl.tools ?? []);
      expect(card.nodeConfig ?? null).toEqual(tpl.nodeConfig ?? null);
      // …user-owned fields preserved.
      expect(card.prompt).toBe(tpl.prompt);
      expect(card.name).toBe(tpl.name);
    }

    // The specific demo bug is fixed: Implementer is armed + has the safe cmd.
    const fc3 = res.workflow.graph.cards.find((c) => c.id === "fc3")!;
    const fc3Tpl = FEATURE_CREW.graph.cards.find((c) => c.id === "fc3")!;
    expect(fc3.unattended).toBe(true);
    expect(fc3.nodeConfig?.verifyCmd).toBe(fc3Tpl.nodeConfig?.verifyCmd);
    expect(fc3.nodeConfig?.verifyCmd).not.toBe("npm test");
  });

  it("leaves a user-customized clone untouched (one prompt edited)", () => {
    const customized = staleClone(2, "My Feature Crew", "feature-crew");
    // The user edited one card's prompt → no longer an unmodified clone.
    customized.graph.cards[0].prompt += "\n\nExtra house rule from the user.";
    const snapshot = JSON.stringify(customized);

    const [res] = healStaleTemplateClones([customized]);
    expect(res.changed).toBe(false);
    // Returned byte-for-byte unchanged — including the still-stale config we
    // must not silently rewrite under a deliberate edit.
    expect(JSON.stringify(res.workflow)).toBe(snapshot);
    expect(res.workflow.graph.cards[1].unattended).toBe(false);
  });

  it("does not touch a workflow that matches no template", () => {
    const foreign = wf(3, "Hand-built", {
      cards: [
        {
          id: "x1",
          name: "Solo",
          preset: "general",
          prompt: "do a thing",
          tools: ["run_shell"],
          schedule: null,
          backend: null,
          unattended: false,
          x: 0,
          y: 0,
        },
      ],
      edges: [],
    });
    const [res] = healStaleTemplateClones([foreign]);
    expect(res.changed).toBe(false);
    expect(res.workflow).toBe(foreign);
  });

  it("is idempotent — re-healing an already-healed clone reports no change", () => {
    const stale = staleClone(4, "Feature Crew", "feature-crew");
    const [first] = healStaleTemplateClones([stale]);
    expect(first.changed).toBe(true);

    const [second] = healStaleTemplateClones([first.workflow]);
    expect(second.changed).toBe(false);
    // The healed graph is returned unchanged (same identity) on the second pass.
    expect(second.workflow).toBe(first.workflow);
  });

  it("heals only the stale clones in a mixed list, returning the rest unchanged", () => {
    const stale = staleClone(5, "Feature Crew", "feature-crew");
    const fresh = wf(
      6,
      "Fresh Bug Hunter",
      cloneTemplateGraph(FLOW_TEMPLATES.find((t) => t.id === "bug-hunter")!),
    );
    const results = healStaleTemplateClones([stale, fresh]);
    expect(results[0].changed).toBe(true);
    // A pristine clone (already current template config) needs no heal.
    expect(results[1].changed).toBe(false);
    expect(results[1].workflow).toBe(fresh);
  });
});
