import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, cloneTemplateGraph } from "../templates";
import { validateGraph } from "../graph";

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
