import { describe, expect, it } from "vitest";
import { parseTags, encodeTags, tagsFromInput } from "../conversation-tags";

describe("parseTags", () => {
  it("returns [] for null/empty/garbage input", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("not json")).toEqual([]);
    expect(parseTags("123")).toEqual([]);
    expect(parseTags('{"a":1}')).toEqual([]);
  });

  it("parses a JSON array of strings", () => {
    expect(parseTags('["work","urgent"]')).toEqual(["work", "urgent"]);
  });

  it("trims, drops non-strings, and de-dupes case-insensitively", () => {
    expect(parseTags('[" work ","Work",5,"urgent",""]')).toEqual([
      "work",
      "urgent",
    ]);
  });
});

describe("encodeTags", () => {
  it("returns null for an empty result", () => {
    expect(encodeTags([])).toBeNull();
    expect(encodeTags(["", "   "])).toBeNull();
  });

  it("encodes a de-duplicated, trimmed array", () => {
    expect(encodeTags([" a ", "A", "b"])).toBe('["a","b"]');
  });
});

describe("tagsFromInput", () => {
  it("splits on commas and newlines, trimming blanks", () => {
    expect(tagsFromInput("a, b\nc ,, ")).toEqual(["a", "b", "c"]);
  });
});
