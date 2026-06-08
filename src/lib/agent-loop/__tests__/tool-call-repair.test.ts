import { describe, expect, it } from "vitest";
import { attemptRepairArgs, finalizeToolCalls } from "../tool-call-merge";
import type { PartialToolCall } from "../stream-types";

describe("attemptRepairArgs", () => {
  it("strips a ```json code fence", () => {
    const r = attemptRepairArgs('```json\n{"path":"a.txt"}\n```');
    expect(r?.repaired).toEqual({ path: "a.txt" });
    expect(r?.kind).toBe("fence");
  });

  it("straightens smart quotes", () => {
    const r = attemptRepairArgs('{“path”:“a.txt”}');
    expect(r?.repaired).toEqual({ path: "a.txt" });
  });

  it("drops trailing commas", () => {
    const r = attemptRepairArgs('{"path":"a.txt","recursive":true,}');
    expect(r?.repaired).toEqual({ path: "a.txt", recursive: true });
  });

  it("converts single quotes when no double quotes present", () => {
    const r = attemptRepairArgs("{'path':'a.txt'}");
    expect(r?.repaired).toEqual({ path: "a.txt" });
    expect(r?.kind).toBe("single-quotes");
  });

  it("wraps a brace-less object", () => {
    const r = attemptRepairArgs('"path":"a.txt","recursive":true');
    expect(r?.repaired).toEqual({ path: "a.txt", recursive: true });
    expect(r?.kind).toBe("naked-object");
  });

  it("does NOT corrupt a double-quoted string containing an apostrophe", () => {
    const r = attemptRepairArgs('{"q":"it\'s fine"}');
    expect(r?.repaired).toEqual({ q: "it's fine" });
  });

  it("returns null for hopeless input (caller falls back to raw)", () => {
    expect(attemptRepairArgs("not json at all <<<")).toBeNull();
    expect(attemptRepairArgs("")).toBeNull();
    expect(attemptRepairArgs("   ")).toBeNull();
  });

  it("never returns an array (tool args must be an object)", () => {
    expect(attemptRepairArgs("[1,2,3]")).toBeNull();
  });
});

describe("finalizeToolCalls uses the repair path", () => {
  const slot = (name: string, argStr: string): PartialToolCall => ({
    id: "call_1",
    function: { name, arguments: argStr, _argStr: argStr },
  });

  it("recovers malformed args into a parsed object", () => {
    const out = finalizeToolCalls([slot("delete_path", "{'path':'tmp/x',}")]);
    expect(out[0].function.name).toBe("delete_path");
    expect(out[0].function.arguments).toEqual({ path: "tmp/x" });
  });

  it("leaves valid JSON untouched", () => {
    const out = finalizeToolCalls([slot("read_file", '{"path":"a.txt"}')]);
    expect(out[0].function.arguments).toEqual({ path: "a.txt" });
  });

  it("falls back to the raw string when unrepairable", () => {
    const out = finalizeToolCalls([slot("read_file", "garbage <<<")]);
    expect(out[0].function.arguments).toBe("garbage <<<");
  });
});
