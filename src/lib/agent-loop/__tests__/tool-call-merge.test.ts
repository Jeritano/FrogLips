import { describe, expect, it } from "vitest";
import { finalizeToolCalls, mergeToolCallChunk } from "../tool-call-merge";
import type { PartialToolCall } from "../stream-types";

/** Build a tool_call chunk; `function` always carries both fields the
 *  wire-shaped delta type expects (either may be an empty placeholder). */
function chunk(
  name: string,
  args: string | Record<string, unknown>,
  extra: { id?: string; type?: "function" } = {},
) {
  return { ...extra, function: { name, arguments: args } };
}

describe("mergeToolCallChunk", () => {
  it("merges a name then piecewise string argument fragments", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("read_file", "", { id: "c1", type: "function" }));
    mergeToolCallChunk(acc, 0, chunk("", '{"path":"/tm'));
    mergeToolCallChunk(acc, 0, chunk("", 'p/x"}'));
    const out = finalizeToolCalls(acc);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("c1");
    expect(out[0].function.name).toBe("read_file");
    expect(out[0].function.arguments).toEqual({ path: "/tmp/x" });
  });

  it("keeps the first non-empty name and ignores later empty name fields", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("list_dir", ""));
    mergeToolCallChunk(acc, 0, chunk("", "{}"));
    expect(finalizeToolCalls(acc)[0].function.name).toBe("list_dir");
  });

  it("merges chunks keyed by index into separate tool calls", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("tool_a", "{}", { id: "a" }));
    mergeToolCallChunk(acc, 1, chunk("tool_b", "{}", { id: "b" }));
    const out = finalizeToolCalls(acc);
    expect(out.map((t) => t.function.name)).toEqual(["tool_a", "tool_b"]);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("accepts an object-form arguments chunk (replace semantics)", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("search", { q: "term" }, { id: "o1" }));
    expect(finalizeToolCalls(acc)[0].function.arguments).toEqual({ q: "term" });
  });

  it("object-form arguments override any prior string fragment", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", '{"old":1}'));
    mergeToolCallChunk(acc, 0, chunk("", { fresh: true }));
    expect(finalizeToolCalls(acc)[0].function.arguments).toEqual({ fresh: true });
  });
});

describe("finalizeToolCalls", () => {
  it("drops name-less slots", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("", '{"orphan":true}'));
    mergeToolCallChunk(acc, 1, chunk("valid", "{}"));
    const out = finalizeToolCalls(acc);
    expect(out).toHaveLength(1);
    expect(out[0].function.name).toBe("valid");
  });

  it("skips empty (undefined) slots in a sparse accumulator", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 2, chunk("gap", "{}"));
    const out = finalizeToolCalls(acc);
    expect(out).toHaveLength(1);
    expect(out[0].function.name).toBe("gap");
  });

  it("falls back to the raw string when arguments are not valid JSON", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", "not-json"));
    expect(finalizeToolCalls(acc)[0].function.arguments).toBe("not-json");
  });

  it("uses empty-string arguments when no fragment ever arrived", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, { function: { name: "noargs" } as { name: string; arguments: string } });
    expect(finalizeToolCalls(acc)[0].function.arguments).toBe("");
  });

  it("defaults a missing id to an empty string and forces type 'function'", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", "{}"));
    const out = finalizeToolCalls(acc)[0];
    expect(out.id).toBe("");
    expect(out.type).toBe("function");
  });

  it("returns an empty array for an empty accumulator", () => {
    expect(finalizeToolCalls([])).toEqual([]);
  });
});
