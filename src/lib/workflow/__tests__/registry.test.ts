import { describe, expect, it } from "vitest";
import { HANDLERS } from "../node-handlers/registry";
import { ADVANCED_NODE_TYPES } from "../create-flow";
import { WORKFLOW_NODE_TYPES, type WorkflowNodeType } from "../../../types";

/**
 * Parity guard: the node-handler registry, the UI picker list
 * (`WORKFLOW_NODE_TYPES`), and the `WorkflowNodeType` union must stay in sync.
 * A new node type can't be added without a registered handler (and vice-versa),
 * and the CardForm picker can't drift from the handlers.
 */
describe("node-handler registry parity", () => {
  const registryKeys = Object.keys(HANDLERS).sort();
  const pickerKeys = WORKFLOW_NODE_TYPES.map((t) => t.value).sort();

  // A compile-time exhaustiveness check: every union member must be a registry
  // key. (If a member were missing, `Record<WorkflowNodeType, …>` wouldn't
  // compile — this list is the runtime mirror used in the assertions below.)
  const unionKeys: WorkflowNodeType[] = [
    "agent",
    "moa",
    "consistency",
    "critic",
    "cascade",
    "router",
    "blackboard",
    "budget",
  ];

  it("registry keys === WORKFLOW_NODE_TYPES === WorkflowNodeType union", () => {
    expect(registryKeys).toEqual([...unionKeys].sort());
    expect(pickerKeys).toEqual([...unionKeys].sort());
    expect(registryKeys).toEqual(pickerKeys);
  });

  it("each handler's type matches its registry key", () => {
    for (const [key, handler] of Object.entries(HANDLERS)) {
      expect(handler.type).toBe(key);
    }
  });

  it("each handler carries the picker's label + blurb", () => {
    for (const t of WORKFLOW_NODE_TYPES) {
      const handler = HANDLERS[t.value];
      expect(handler.label).toBe(t.label);
      expect(handler.blurb).toBe(t.blurb);
    }
  });

  it("ADVANCED_NODE_TYPES === the handlers flagged advancedAllowed", () => {
    const advanced = Object.values(HANDLERS)
      .filter((h) => h.advancedAllowed)
      .map((h) => h.type)
      .sort();
    expect([...ADVANCED_NODE_TYPES].sort()).toEqual(advanced);
    // The historical advanced set (the regression baseline).
    expect([...ADVANCED_NODE_TYPES].sort()).toEqual(
      ["agent", "cascade", "consistency", "critic", "moa"].sort(),
    );
  });
});
