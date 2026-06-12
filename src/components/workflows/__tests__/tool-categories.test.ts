import { describe, expect, it } from "vitest";
import {
  applyMasterToggle,
  defaultCollapsed,
  masterStateOf,
  resolveToolGroups,
  TOOL_CATEGORIES,
} from "../tool-categories";

describe("TOOL_CATEGORIES invariants", () => {
  it("has no duplicate tool across categories", () => {
    const seen = new Map<string, string>();
    for (const cat of TOOL_CATEGORIES) {
      for (const t of cat.tools) {
        expect(
          seen.has(t),
          `'${t}' is in both '${seen.get(t)}' and '${cat.id}'`,
        ).toBe(false);
        seen.set(t, cat.id);
      }
    }
  });

  it("has unique category ids", () => {
    const ids = TOOL_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveToolGroups", () => {
  it("returns just the explicit categories when ALL_TOOLS only contains categorized tools", () => {
    const known = TOOL_CATEGORIES.flatMap((c) => c.tools);
    const groups = resolveToolGroups(known);
    expect(groups.length).toBe(TOOL_CATEGORIES.length);
    expect(groups.find((g) => g.id === "other")).toBeUndefined();
  });

  it("appends an Other bucket when ALL_TOOLS has uncategorized tools", () => {
    const known = TOOL_CATEGORIES.flatMap((c) => c.tools);
    const groups = resolveToolGroups([
      ...known,
      "totally_new_tool",
      "another_one",
    ]);
    const other = groups.find((g) => g.id === "other");
    expect(other).toBeDefined();
    expect(other!.tools).toEqual(["totally_new_tool", "another_one"]);
  });

  it("preserves category order followed by Other", () => {
    const known = TOOL_CATEGORIES.flatMap((c) => c.tools);
    const groups = resolveToolGroups([...known, "x_other"]);
    expect(groups.map((g) => g.id)).toEqual([
      ...TOOL_CATEGORIES.map((c) => c.id),
      "other",
    ]);
  });
});

describe("masterStateOf", () => {
  it("returns 'none' when no group tools are selected", () => {
    expect(masterStateOf([], ["a", "b", "c"])).toBe("none");
    expect(masterStateOf(["x", "y"], ["a", "b"])).toBe("none");
  });

  it("returns 'all' when every group tool is selected", () => {
    expect(masterStateOf(["a", "b"], ["a", "b"])).toBe("all");
    expect(masterStateOf(["a", "b", "c"], ["a", "b"])).toBe("all");
  });

  it("returns 'some' for partial overlap", () => {
    expect(masterStateOf(["a"], ["a", "b"])).toBe("some");
  });
});

describe("applyMasterToggle", () => {
  it("none → all: adds every group tool", () => {
    const out = applyMasterToggle(["x"], ["a", "b"]);
    expect(out.sort()).toEqual(["a", "b", "x"]);
  });

  it("some → all: fills in missing group tools", () => {
    const out = applyMasterToggle(["a", "x"], ["a", "b", "c"]);
    expect(out.sort()).toEqual(["a", "b", "c", "x"]);
  });

  it("all → none: removes every group tool, preserves outside-group tools", () => {
    const out = applyMasterToggle(["a", "b", "x"], ["a", "b"]);
    expect(out).toEqual(["x"]);
  });

  it("preserves unknown tools (set via direct DB edit) on toggle", () => {
    const out = applyMasterToggle(["legacy_tool", "a"], ["a", "b"]);
    expect(out).toContain("legacy_tool");
  });
});

describe("defaultCollapsed", () => {
  it("collapses empty groups", () => {
    expect(defaultCollapsed(0, 5)).toBe(true);
  });
  it("collapses full groups", () => {
    expect(defaultCollapsed(5, 5)).toBe(true);
  });
  it("expands mixed groups", () => {
    expect(defaultCollapsed(2, 5)).toBe(false);
  });
});
