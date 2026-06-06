import { describe, expect, it, vi } from "vitest";
import { routeMessage, type ChatRoute } from "../chat-router";

/**
 * Router decision logic. `classify` is injected so the pipeline is tested
 * deterministically without a real model.
 */

const ROUTES: ChatRoute[] = [
  { id: "code", label: "Coder", whenToUse: "programming, debugging", keywords: ["```", "stack trace"], model: "qwen3-coder", backend: "ollama", preset: "coder" },
  { id: "web", label: "Web", whenToUse: "current events, look something up", model: "llama3", backend: "ollama" },
  { id: "reason", label: "Reasoner", whenToUse: "hard math and logic", model: "deepseek-r1:cloud", backend: "ollama", isDefault: true },
];

describe("routeMessage", () => {
  it("returns null when there are no routes", async () => {
    const d = await routeMessage("hi", [], { classify: async () => "1" });
    expect(d).toBeNull();
  });

  it("takes the keyword fast-path without calling the classifier", async () => {
    const classify = vi.fn(async () => "2");
    const d = await routeMessage("here is a ``` code block", ROUTES, { classify });
    expect(d?.routeId).toBe("code");
    expect(d?.method).toBe("keyword");
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses the classifier's pick when no keyword matches", async () => {
    const d = await routeMessage("what happened in the news today", ROUTES, {
      classify: async () => "2 — looks like a lookup",
    });
    expect(d?.routeId).toBe("web");
    expect(d?.method).toBe("classifier");
    expect(d?.reason).toContain("lookup");
  });

  it("marks the decision sticky when the classifier keeps the current route", async () => {
    const d = await routeMessage("more about that", ROUTES, {
      stickyRouteId: "web",
      classify: async () => "2",
    });
    expect(d?.routeId).toBe("web");
    expect(d?.method).toBe("sticky");
  });

  it("falls back to the default route when the classifier is unparseable", async () => {
    const d = await routeMessage("ambiguous thing", ROUTES, {
      classify: async () => "no idea",
    });
    expect(d?.routeId).toBe("reason"); // isDefault
    expect(d?.method).toBe("default");
  });

  it("falls back to default when the classifier throws", async () => {
    const d = await routeMessage("ambiguous thing", ROUTES, {
      classify: async () => {
        throw new Error("model down");
      },
    });
    expect(d?.routeId).toBe("reason");
    expect(d?.method).toBe("default");
  });

  it("clamps an out-of-range classifier number to default", async () => {
    const d = await routeMessage("thing", ROUTES, { classify: async () => "99" });
    expect(d?.method).toBe("default");
  });

  it("ignores numbers inside reasoning <think> blocks (picks the final answer)", async () => {
    // A reasoning model that streams its chain-of-thought inline: the '2' and
    // '3' are inside <think>; the real answer is '1' after it.
    const d = await routeMessage("debug my code", ROUTES, {
      classify: async () => "<think>could be 2 (web) or 3 (reason)...</think>\n1",
    });
    expect(d?.routeId).toBe("code");
    expect(d?.method).toBe("classifier");
  });

  it("handles an unclosed trailing <think> by falling back to default", async () => {
    const d = await routeMessage("x", ROUTES, {
      classify: async () => "<think>hmm 2 then 3 then",
    });
    expect(d?.method).toBe("default"); // no parseable answer outside the think block
  });
});
