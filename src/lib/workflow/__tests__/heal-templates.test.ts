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

  it("heals despite an edited prompt — prompts no longer block the match", () => {
    // An OLD clone necessarily has older prompt wording than the current
    // template (which gains path-discipline blocks etc). The match keys on the
    // card-id SET, not prompt equality, so such a clone still heals.
    const stale = staleClone(2, "Feature Crew", "feature-crew");
    stale.graph.cards.find((c) => c.id === "fc3")!.prompt +=
      "\n\n(older wording — predates the current template)";

    const [res] = healStaleTemplateClones([stale]);
    expect(res.changed).toBe(true);
    const fc3 = res.workflow.graph.cards.find((c) => c.id === "fc3")!;
    expect(fc3.unattended).toBe(true); // re-armed
    expect(fc3.nodeConfig?.verifyCmd).not.toBe("npm test"); // verify swapped
    expect(fc3.prompt).toContain("older wording"); // prompt preserved
  });

  it("does NOT re-arm a card whose tools the user changed", () => {
    const customized = staleClone(7, "Feature Crew", "feature-crew");
    const fc3 = customized.graph.cards.find((c) => c.id === "fc3")!;
    // User deliberately narrowed the Implementer's tools → a customization we
    // must respect; its arm state stays as the user left it (disarmed).
    fc3.tools = ["read_file", "write_file"];

    const [res] = healStaleTemplateClones([customized]);
    const healedFc3 = res.workflow.graph.cards.find((c) => c.id === "fc3")!;
    expect(healedFc3.unattended).toBe(false); // tools differ → not re-armed
    expect(healedFc3.tools).toEqual(["read_file", "write_file"]); // tools kept
  });

  it("does NOT overwrite a user's custom verify command", () => {
    const customized = staleClone(8, "Feature Crew", "feature-crew");
    const fc3 = customized.graph.cards.find((c) => c.id === "fc3")!;
    fc3.nodeConfig = { ...fc3.nodeConfig, verifyCmd: "pytest -q" };

    const [res] = healStaleTemplateClones([customized]);
    const healedFc3 = res.workflow.graph.cards.find((c) => c.id === "fc3")!;
    // Only the exact stale "npm test" literal is swapped — a real command stays.
    expect(healedFc3.nodeConfig?.verifyCmd).toBe("pytest -q");
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
