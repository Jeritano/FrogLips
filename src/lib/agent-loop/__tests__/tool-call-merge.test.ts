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

  it("defaults arguments to '{}' when no fragment ever arrived", () => {
    // Cloud routing parses `arguments` as JSON, so an empty string would
    // trip "Value looks like object, but can't find closing '}'". `"{}"`
    // is the safe well-formed-empty default.
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, { function: { name: "noargs" } as { name: string; arguments: string } });
    expect(finalizeToolCalls(acc)[0].function.arguments).toBe("{}");
  });

  it("mints a stable id when none arrived and forces type 'function'", () => {
    // Ollama's cloud passthrough pairs each `role:"tool"` result with the
    // assistant's `tool_calls[].id` and rejects the request when the linkage
    // is empty. `finalizeToolCalls` mints `call_<8>` so the result message
    // (which copies tc.id into `tool_call_id`) round-trips correctly.
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", "{}"));
    const out = finalizeToolCalls(acc)[0];
    expect(out.id).toMatch(/^call_[0-9a-z]{8}$/);
    expect(out.type).toBe("function");
  });

  it("preserves a safe upstream-provided id verbatim", () => {
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", "{}", { id: "given_42" }));
    expect(finalizeToolCalls(acc)[0].id).toBe("given_42");
  });

  it("replaces upstream ids with disallowed characters", () => {
    // kimi-k2.6:cloud occasionally emits ids like `functions.web_search:0`
    // and then rejects that same id on the round-trip with the cryptic
    // "Value looks like object, but can't find closing '}' symbol" 400.
    // Anything outside `[A-Za-z0-9_-]` is replaced with a minted `call_<8>`.
    const acc: PartialToolCall[] = [];
    mergeToolCallChunk(acc, 0, chunk("t", "{}", { id: "functions.web_search:0" }));
    expect(finalizeToolCalls(acc)[0].id).toMatch(/^call_[0-9a-z]{8}$/);
  });

  it("returns an empty array for an empty accumulator", () => {
    expect(finalizeToolCalls([])).toEqual([]);
  });
});
