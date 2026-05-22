import { describe, expect, it } from "vitest";
import {
  emptyParams,
  parseConversationParams,
  paramsAreEmpty,
  serializeConversationParams,
} from "../conversation-params";

describe("parseConversationParams", () => {
  it("returns all-null for null/empty/garbage input", () => {
    expect(parseConversationParams(null)).toEqual(emptyParams());
    expect(parseConversationParams("")).toEqual(emptyParams());
    expect(parseConversationParams("not json")).toEqual(emptyParams());
    expect(parseConversationParams("123")).toEqual(emptyParams());
  });

  it("decodes a full params object", () => {
    const raw = JSON.stringify({
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 512,
      system_prompt: "be terse",
    });
    expect(parseConversationParams(raw)).toEqual({
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 512,
      system_prompt: "be terse",
    });
  });

  it("clamps out-of-range numbers", () => {
    const raw = JSON.stringify({ temperature: 99, top_p: -1, max_tokens: 0.5 });
    const p = parseConversationParams(raw);
    expect(p.temperature).toBe(2);
    expect(p.top_p).toBe(0);
    expect(p.max_tokens).toBe(1);
  });

  it("drops a blank system prompt", () => {
    expect(parseConversationParams(JSON.stringify({ system_prompt: "   " })).system_prompt).toBeNull();
  });
});

describe("serializeConversationParams", () => {
  it("returns null when every field is empty", () => {
    expect(serializeConversationParams(emptyParams())).toBeNull();
  });

  it("round-trips through parse", () => {
    const p = { temperature: 0.3, top_p: null, max_tokens: 256, system_prompt: "x" };
    const raw = serializeConversationParams(p);
    expect(raw).not.toBeNull();
    expect(parseConversationParams(raw)).toEqual(p);
  });
});

describe("paramsAreEmpty", () => {
  it("true only when all fields null", () => {
    expect(paramsAreEmpty(emptyParams())).toBe(true);
    expect(paramsAreEmpty({ ...emptyParams(), temperature: 0.5 })).toBe(false);
  });
});
