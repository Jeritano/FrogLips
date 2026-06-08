import { describe, expect, it } from "vitest";
import { FLOW_SCHEMA_VERSION, flowFromDoc, flowToDoc } from "../export";
import { FLOW_TEMPLATES, cloneTemplateGraph } from "../templates";

describe("flow export/import", () => {
  it("round-trips a template Flow", () => {
    const t = FLOW_TEMPLATES[0];
    const doc = flowToDoc(t.name, cloneTemplateGraph(t));
    const r = flowFromDoc(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe(t.name);
      expect(r.graph.cards.length).toBe(t.graph.cards.length);
      expect(r.graph.edges.length).toBe(t.graph.edges.length);
    }
  });

  it("carries the schema version + magic key", () => {
    const doc = JSON.parse(flowToDoc("X", { cards: [], edges: [] }));
    expect(doc.froglips_flow).toBe(FLOW_SCHEMA_VERSION);
  });

  it("rejects non-JSON", () => {
    const r = flowFromDoc("not json {{{");
    expect(r.ok).toBe(false);
  });

  it("rejects a non-Flow object", () => {
    const r = flowFromDoc(JSON.stringify({ hello: "world" }));
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects an unsupported future version", () => {
    const r = flowFromDoc(JSON.stringify({ froglips_flow: 99, name: "X", graph: { cards: [], edges: [] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("version");
  });

  it("rejects an invalid (non-linear) graph", () => {
    const bad = {
      froglips_flow: 1,
      name: "bad",
      graph: {
        cards: [
          { id: "a", name: "A", preset: "general", prompt: "x", tools: [], schedule: null, backend: null, model: null, placed: true, unattended: false, x: 0, y: 0 },
          { id: "b", name: "B", preset: "general", prompt: "x", tools: [], schedule: null, backend: null, model: null, placed: true, unattended: false, x: 0, y: 0 },
          { id: "c", name: "C", preset: "general", prompt: "x", tools: [], schedule: null, backend: null, model: null, placed: true, unattended: false, x: 0, y: 0 },
        ],
        edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }], // fan-in → invalid
      },
    };
    const r = flowFromDoc(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });
});
