import { describe, expect, it } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import { reconcileNodeChanges } from "../WorkflowCanvas";
import type { AgentCardNodeData } from "../AgentCardNode";
import type { WorkflowCard } from "../../../types";

function card(id: string, x = 0, y = 0): WorkflowCard {
  return {
    id,
    name: `Card ${id}`,
    preset: "general",
    prompt: `prompt ${id}`,
    tools: [],
    schedule: null,
    backend: null,
    placed: true,
    x,
    y,
  };
}

function node(id: string, x = 0, y = 0): Node<AgentCardNodeData> {
  return {
    id,
    type: "agentCard",
    position: { x, y },
    data: {
      name: `Card ${id}`,
      preset: "general",
      schedule: null,
      state: "idle",
      midChain: false,
      onConfigure: () => {},
      onRun: () => {},
      onDelete: () => {},
    },
  };
}

describe("reconcileNodeChanges", () => {
  it("keeps a just-added card that React Flow has not registered yet", () => {
    // cards has two placed cards; nodes lags behind with only the first
    // (the second was created but its node is not yet in React Flow's store).
    const cards = [card("a"), card("b")];
    const nodes = [node("a")];
    // React Flow emits a measurement/select batch referencing only "a".
    const changes: NodeChange[] = [
      { type: "select", id: "a", selected: false },
    ];
    const next = reconcileNodeChanges(changes, nodes, cards);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("never drops a card on a batch that omits it", () => {
    const cards = [card("a"), card("b"), card("c")];
    const nodes = [node("a"), node("b"), node("c")];
    // A batch touching only one node must leave the others intact.
    const changes: NodeChange[] = [
      { type: "position", id: "b", position: { x: 50, y: 60 } },
    ];
    const next = reconcileNodeChanges(changes, nodes, cards);
    expect(next.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.find((c) => c.id === "b")).toMatchObject({ x: 50, y: 60 });
  });

  it("removes a card only on an explicit remove change", () => {
    const cards = [card("a"), card("b")];
    const nodes = [node("a"), node("b")];
    const changes: NodeChange[] = [{ type: "remove", id: "a" }];
    const next = reconcileNodeChanges(changes, nodes, cards);
    expect(next.map((c) => c.id)).toEqual(["b"]);
  });

  it("syncs drag positions back to the card model", () => {
    const cards = [card("a", 0, 0)];
    const nodes = [node("a", 0, 0)];
    const changes: NodeChange[] = [
      { type: "position", id: "a", position: { x: 200, y: 120 } },
    ];
    const next = reconcileNodeChanges(changes, nodes, cards);
    expect(next[0]).toMatchObject({ x: 200, y: 120 });
  });
});
