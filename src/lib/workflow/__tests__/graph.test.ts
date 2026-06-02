import { describe, expect, it } from "vitest";
import type { WorkflowCard, WorkflowGraph } from "../../../types";
import { resolveLinearOrder, validateGraph, WorkflowGraphError } from "../graph";

function card(id: string): WorkflowCard {
  return {
    id,
    name: `Card ${id}`,
    preset: "general",
    prompt: `prompt ${id}`,
    tools: [],
    schedule: null,
    backend: null,
    x: 0,
    y: 0,
  };
}

describe("resolveLinearOrder", () => {
  it("resolves a three-card chain into start-to-end order", () => {
    const graph: WorkflowGraph = {
      cards: [card("b"), card("c"), card("a")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(resolveLinearOrder(graph).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for an empty graph", () => {
    expect(resolveLinearOrder({ cards: [], edges: [] })).toEqual([]);
  });

  it("accepts a single card with no edges", () => {
    expect(resolveLinearOrder({ cards: [card("a")], edges: [] }).map((c) => c.id))
      .toEqual(["a"]);
  });

  it("rejects a cycle", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    expect(() => resolveLinearOrder(graph)).toThrow(WorkflowGraphError);
    expect(() => resolveLinearOrder(graph)).toThrow(/cycle/i);
  });

  it("rejects branching (multiple outgoing edges)", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b"), card("c")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
    };
    expect(() => resolveLinearOrder(graph)).toThrow(/branching/i);
  });

  it("rejects merging (multiple incoming edges)", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b"), card("c")],
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };
    expect(() => resolveLinearOrder(graph)).toThrow(/merging/i);
  });

  it("rejects a disconnected card not on the main chain", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b"), card("c")],
      edges: [{ from: "a", to: "b" }],
    };
    expect(() => resolveLinearOrder(graph)).toThrow(/single linear chain/i);
  });

  it("rejects an edge to an unknown card", () => {
    const graph: WorkflowGraph = {
      cards: [card("a")],
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(() => resolveLinearOrder(graph)).toThrow(/unknown card/i);
  });
});

describe("placed filtering", () => {
  it("ignores unplaced cards when resolving the chain", () => {
    const a = { ...card("a"), placed: true };
    const b = { ...card("b"), placed: true };
    const ghost = { ...card("ghost"), placed: false };
    const graph: WorkflowGraph = {
      cards: [a, b, ghost],
      edges: [{ from: "a", to: "b" }],
    };
    expect(resolveLinearOrder(graph).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not flag unplaced cards as disconnected start cards", () => {
    const a = { ...card("a"), placed: true };
    const ghost = { ...card("ghost"), placed: false };
    const res = validateGraph({ cards: [a, ghost], edges: [] });
    expect(res.ok).toBe(true);
  });

  it("drops edges that reference unplaced cards", () => {
    const a = { ...card("a"), placed: true };
    const ghost = { ...card("ghost"), placed: false };
    const graph: WorkflowGraph = {
      cards: [a, ghost],
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(resolveLinearOrder(graph).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("multiple placed cards", () => {
  it("keeps every placed card in a connected chain", () => {
    const cards = ["a", "b", "c", "d"].map((id) => ({ ...card(id), placed: true }));
    const graph: WorkflowGraph = {
      cards,
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
      ],
    };
    const order = resolveLinearOrder(graph);
    expect(order.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("validates a four-card chain as a runnable workflow", () => {
    const cards = ["a", "b", "c", "d"].map((id) => ({ ...card(id), placed: true }));
    const res = validateGraph({
      cards,
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.order).toHaveLength(4);
  });
});

describe("validateGraph", () => {
  it("returns ok with the resolved order for a valid chain", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [{ from: "a", to: "b" }],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.order.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns an error string for an invalid graph instead of throwing", () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cycle/i);
  });
});
