import { describe, expect, it } from "vitest";
import { parseDetachedParams } from "../detached-params";

describe("parseDetachedParams", () => {
  it("parses ?detached=1&conversation_id=abc … wait, only integers", () => {
    expect(parseDetachedParams("?detached=1&conversation_id=abc")).toBeNull();
  });

  it("returns the conversation id when both params are present", () => {
    expect(parseDetachedParams("?detached=1&conversation_id=42")).toEqual({
      conversationId: 42,
    });
  });

  it("accepts a search string without a leading ?", () => {
    expect(parseDetachedParams("detached=1&conversation_id=7")).toEqual({
      conversationId: 7,
    });
  });

  it("returns null when detached flag is missing", () => {
    expect(parseDetachedParams("?conversation_id=5")).toBeNull();
  });

  it("returns null when detached is not literally '1'", () => {
    expect(parseDetachedParams("?detached=true&conversation_id=5")).toBeNull();
    expect(parseDetachedParams("?detached=0&conversation_id=5")).toBeNull();
  });

  it("returns null when conversation_id is missing", () => {
    expect(parseDetachedParams("?detached=1")).toBeNull();
  });

  it("rejects non-integer ids", () => {
    expect(parseDetachedParams("?detached=1&conversation_id=3.14")).toBeNull();
    expect(parseDetachedParams("?detached=1&conversation_id=")).toBeNull();
    expect(parseDetachedParams("?detached=1&conversation_id=1e3")).toBeNull();
  });

  it("accepts negative ids (backend validates further)", () => {
    expect(parseDetachedParams("?detached=1&conversation_id=-1")).toEqual({
      conversationId: -1,
    });
  });

  it("rejects ids outside safe-integer range", () => {
    const tooBig = "999999999999999999999";
    expect(parseDetachedParams(`?detached=1&conversation_id=${tooBig}`)).toBeNull();
  });

  it("returns null for an empty search string", () => {
    expect(parseDetachedParams("")).toBeNull();
    expect(parseDetachedParams("?")).toBeNull();
  });
});
