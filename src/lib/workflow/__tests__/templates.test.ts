import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, cloneTemplateGraph } from "../templates";
import { validateGraph } from "../graph";
import { parseWorkflow } from "../../../types";

describe("FLOW_TEMPLATES", () => {
  it("every template is a valid linear Flow", () => {
    for (const t of FLOW_TEMPLATES) {
      const v = validateGraph(t.graph);
      expect(v.ok, `${t.id}: ${v.ok ? "" : v.error}`).toBe(true);
    }
  });

  it("every card carries the required fields", () => {
    for (const t of FLOW_TEMPLATES) {
      for (const c of t.graph.cards) {
        expect(c.id).toBeTruthy();
        expect(c.name).toBeTruthy();
        expect(c.preset).toBeTruthy();
        expect(c.prompt.length).toBeGreaterThan(10);
      }
    }
  });

  it("template ids are unique", () => {
    const ids = FLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cloneTemplateGraph deep-copies (mutation-safe)", () => {
    const t = FLOW_TEMPLATES[0];
    const a = cloneTemplateGraph(t);
    a.cards[0].name = "MUTATED";
    expect(t.graph.cards[0].name).not.toBe("MUTATED");
    expect(cloneTemplateGraph(t).cards[0].name).not.toBe("MUTATED");
  });
});

/* ── Dev-workforce templates (Feature Crew / Bug Hunter) ─────────────────────
 * These two lean on the Wave 1 primitives, so beyond plain graph validity we
 * assert the orchestration config survives the persistence path: templates
 * are cloned into graph_json and read back through parseWorkflow, whose
 * normalizeNodeConfig clamps/drops anything malformed. A silently-dropped
 * verifyCmd or haltWhen would neuter the template without failing a run. */

describe("dev-workforce templates", () => {
  const featureCrew = FLOW_TEMPLATES.find((t) => t.id === "feature-crew")!;
  const bugHunter = FLOW_TEMPLATES.find((t) => t.id === "bug-hunter")!;
  const both = [featureCrew, bugHunter];

  /** Seed a template the way the app does: serialize → parse → normalize. */
  const seed = (t: (typeof FLOW_TEMPLATES)[number]) =>
    parseWorkflow({
      id: 1,
      name: t.name,
      graph_json: JSON.stringify(cloneTemplateGraph(t)),
      created_at: 0,
      updated_at: 0,
    });

  it("both templates exist in the gallery", () => {
    expect(featureCrew).toBeTruthy();
    expect(bugHunter).toBeTruthy();
  });

  it("nodeType + nodeConfig survive the graph_json seed round-trip unchanged", () => {
    for (const t of both) {
      const wf = seed(t);
      expect(wf.graph.cards.length).toBe(t.graph.cards.length);
      expect(wf.graph.edges.length).toBe(t.graph.edges.length);
      for (const [i, c] of wf.graph.cards.entries()) {
        const orig = t.graph.cards[i];
        expect(c.nodeType, `${t.id}/${orig.id} nodeType`).toBe(
          orig.nodeType ?? "agent",
        );
        // Every authored config field must survive normalizeNodeConfig's
        // clamps verbatim — a clamped value means the template is out of range.
        expect(c.nodeConfig, `${t.id}/${orig.id} nodeConfig`).toEqual(
          orig.nodeConfig,
        );
      }
      const v = validateGraph(wf.graph);
      expect(v.ok, `${t.id}: ${v.ok ? "" : v.error}`).toBe(true);
    }
  });

  it("every card carries a budget ceiling", () => {
    for (const t of both) {
      for (const c of t.graph.cards) {
        expect(c.nodeConfig?.maxMs, `${t.id}/${c.id} maxMs`).toBeGreaterThan(0);
      }
    }
  });

  it("critic cards are execution-grounded with an independent critic stance", () => {
    const critics = both.flatMap((t) =>
      t.graph.cards.filter((c) => c.nodeType === "critic"),
    );
    expect(critics.length).toBe(2); // Implementer + Fixer
    for (const c of critics) {
      expect(c.nodeConfig?.verifyCmd).toBeTruthy();
      expect(c.nodeConfig?.criticSystemPrompt).toBeTruthy();
      expect(c.nodeConfig?.criticPrompt).toMatch(/SCORE/);
    }
  });

  it("haltWhen gates the blocking verdicts", () => {
    const reviewer = featureCrew.graph.cards.find((c) => c.id === "fc4")!;
    expect(reviewer.nodeConfig?.haltWhen).toEqual({
      key: "review_verdict",
      equals: "block",
    });
    const reproducer = bugHunter.graph.cards.find((c) => c.id === "bh1")!;
    expect(reproducer.nodeConfig?.haltWhen).toEqual({
      key: "repro_status",
      equals: "failed",
    });
  });

  it("economy: cards run local (model unset); escalation is a :cloud tag on ollama", () => {
    for (const t of both) {
      for (const c of t.graph.cards) {
        expect(c.model, `${t.id}/${c.id} model`).toBeNull();
      }
    }
    const architect = featureCrew.graph.cards.find((c) => c.id === "fc2")!;
    expect(architect.nodeType).toBe("cascade");
    expect(architect.nodeConfig?.escalateModel).toMatch(/:cloud$/);
    expect(architect.nodeConfig?.escalateBackend).toBe("ollama");
    // Bug Hunter never touches the cloud at all.
    for (const c of bugHunter.graph.cards) {
      expect(c.nodeConfig?.escalateModel ?? null).toBeNull();
    }
  });
});
