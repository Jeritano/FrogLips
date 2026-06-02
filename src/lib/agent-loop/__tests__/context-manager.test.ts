import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import {
  applyContextBudget,
  estimateMessagesTokens,
  estimateTokens,
  modelContextTokens,
  DEFAULT_CONTEXT_TOKENS,
} from "../context-manager";

const CONV = 1;

function sys(content: string): Message {
  return { conversation_id: CONV, role: "system", content };
}
function user(content: string): Message {
  return { conversation_id: CONV, role: "user", content };
}
function asst(content: string): Message {
  return { conversation_id: CONV, role: "assistant", content };
}
function tool(content: string): Message {
  return { conversation_id: CONV, role: "tool", content, tool_call_id: "t1", tool_name: "read_file" };
}

/** Build a string of roughly `tokens` estimated tokens (chars/4). */
function blob(tokens: number): string {
  return "x".repeat(tokens * 4);
}

describe("estimation", () => {
  it("estimateTokens uses chars/4", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("estimateMessagesTokens sums bodies plus framing", () => {
    const msgs = [user("abcd"), asst("abcd")];
    // 1 + 1 token of body + 4 framing each = 10
    expect(estimateMessagesTokens(msgs)).toBe(10);
  });
});

describe("modelContextTokens", () => {
  it("falls back to the conservative default for unknown models", () => {
    expect(modelContextTokens(null)).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(modelContextTokens("some-weird-model")).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("applies per-model overrides", () => {
    expect(modelContextTokens("tinyllama")).toBe(2048);
    expect(modelContextTokens("mistral-7b")).toBe(32768);
  });

  it("resolves families broadened in the 2026-05-28 maturity pass", () => {
    expect(modelContextTokens("llama-4-scout")).toBe(128_000);
    expect(modelContextTokens("llama-3.3-70b")).toBe(128_000);
    expect(modelContextTokens("qwen3-8b")).toBe(32_768);
    expect(modelContextTokens("mistral-nemo")).toBe(32_768);
    expect(modelContextTokens("command-r-plus")).toBe(32_768);
    expect(modelContextTokens("phi-4")).toBe(16_384);
    expect(modelContextTokens("phi-3.5-mini")).toBe(16_384);
    // Base phi-3 stays at the conservative 4k (below the 3.5 rule).
    expect(modelContextTokens("phi-3-mini")).toBe(4_096);
    // Explicit window markers win.
    expect(modelContextTokens("somemodel-256k")).toBe(256_000);
    expect(modelContextTokens("bigctx-1m")).toBe(1_000_000);
    // Gemma 2/3 still 8k; gemma4 is the large-window exception.
    expect(modelContextTokens("gemma3:12b")).toBe(8_192);
    expect(modelContextTokens("gemma4:latest")).toBe(128_000);
    expect(modelContextTokens("gemma-4-31b")).toBe(128_000);
  });
});

describe("applyContextBudget", () => {
  it("under budget — returns the array unchanged", () => {
    const msgs = [sys("rules"), user("hi"), asst("hello")];
    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    expect(r.trimmed).toBe(false);
    expect(r.messages).toHaveLength(3);
    expect(r.messages.map((m) => m.content)).toEqual(["rules", "hi", "hello"]);
    expect(r.toolResultsTruncated).toBe(0);
    expect(r.turnsCollapsed).toBe(0);
  });

  it("never mutates the input array or its messages", () => {
    const original = [sys("rules"), tool(blob(5000)), user("q")];
    const snapshot = original.map((m) => m.content);
    applyContextBudget(original, { contextTokens: 2048 });
    expect(original.map((m) => m.content)).toEqual(snapshot);
  });

  it("over budget — truncates large tool-result bodies", () => {
    // Budget = 8192 * 0.75 = 6144 tokens; a 9000-token tool body overflows it
    // and truncation alone (1024-byte head ≈ 256 tokens) brings it back under.
    const msgs = [sys("rules"), tool(blob(9000)), user("q")];
    const r = applyContextBudget(msgs, {
      contextTokens: 8192,
      replyReserveFraction: 0.25,
      toolResultHeadBytes: 1024,
    });
    expect(r.trimmed).toBe(true);
    expect(r.toolResultsTruncated).toBe(1);
    expect(r.turnsCollapsed).toBe(0);
    expect(r.messages[1].content).toContain("[… elided");
    expect(r.messages[1].content.length).toBeLessThan(blob(9000).length);
    // system prompt intact
    expect(r.messages[0].content).toBe("rules");
  });

  it("way over budget — collapses old turns into a synthetic summary", () => {
    const msgs = [
      sys("rules"),
      user(blob(3000)),
      asst(blob(3000)),
      user(blob(3000)),
      asst(blob(3000)),
      user("latest question"),
    ];
    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    expect(r.trimmed).toBe(true);
    expect(r.turnsCollapsed).toBeGreaterThan(0);
    // A synthetic summary system message sits right after the real prompt.
    expect(r.messages[0].content).toBe("rules");
    expect(r.messages[1].role).toBe("system");
    expect(r.messages[1].content).toContain("Conversation summary");
    expect(r.messages[1].content).toContain("NOT model-generated");
    // The most recent message is always kept verbatim.
    expect(r.messages[r.messages.length - 1].content).toBe("latest question");
  });

  it("system prompt is always preserved and never truncated", () => {
    const bigSys = sys(blob(10000));
    const msgs = [bigSys, tool(blob(8000)), user(blob(8000)), asst("a"), user("b")];
    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    expect(r.messages[0]).toBe(bigSys);
    expect(r.messages[0].content).toBe(bigSys.content);
  });

  it("estimatedAfter never exceeds estimatedBefore when trimmed", () => {
    const msgs = [sys("rules"), tool(blob(9000)), user(blob(9000)), asst("a"), user("b")];
    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    expect(r.estimatedAfter).toBeLessThanOrEqual(r.estimatedBefore);
  });
});

describe("collapse preserves tool-call/result pairing (HIGH 2026-05-30)", () => {
  function asstCall(id: string, content: string): Message {
    return {
      conversation_id: CONV,
      role: "assistant",
      content,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
  }
  function toolRes(id: string, content: string): Message {
    return { conversation_id: CONV, role: "tool", content, tool_call_id: id, tool_name: "read_file" };
  }

  /** Every kept `tool` message must have a preceding assistant `tool_calls`
   *  that owns its id — otherwise the backend 400s on an orphaned tool_call_id. */
  function assertNoOrphanToolResults(msgs: Message[]) {
    const seen = new Set<string>();
    for (const m of msgs) {
      if (m.role === "assistant" && m.tool_calls?.length) {
        for (const c of m.tool_calls) seen.add(c.id);
      } else if (m.role === "tool") {
        expect(
          seen.has(m.tool_call_id!),
          `orphan tool result ${m.tool_call_id} has no preceding assistant call`,
        ).toBe(true);
      }
    }
  }

  it("never leaves the kept suffix starting with an orphaned tool result", () => {
    const msgs: Message[] = [sys(blob(80))];
    // 12 tool-call turns with large result bodies → forces collapse at 8k.
    for (let i = 0; i < 12; i++) {
      msgs.push(user(blob(40)));
      msgs.push(asstCall(`call_${i}`, ""));
      msgs.push(toolRes(`call_${i}`, blob(800)));
    }
    msgs.push(user("final question"));

    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    expect(r.trimmed).toBe(true);
    expect(r.turnsCollapsed).toBeGreaterThan(0);
    // Real system prompt still first.
    expect(r.messages[0].role).toBe("system");
    // No orphaned tool results anywhere in the budgeted array.
    assertNoOrphanToolResults(r.messages);
    // The first non-system message must not be a bare tool result.
    const firstNonSystem = r.messages.find((m, i) => i > 0 && m.role !== "system");
    expect(firstNonSystem?.role).not.toBe("tool");
    // Live user request preserved at the tail.
    expect(r.messages[r.messages.length - 1].content).toBe("final question");
  });

  it("backs up to the owning call when the tail is all tool results", () => {
    // Degenerate: a final assistant call followed by several tool results and
    // nothing after — the snap must keep the assistant call with them.
    const msgs: Message[] = [sys(blob(80))];
    for (let i = 0; i < 10; i++) {
      msgs.push(user(blob(40)));
      msgs.push(asstCall(`c${i}`, ""));
      msgs.push(toolRes(`c${i}`, blob(800)));
    }
    const r = applyContextBudget(msgs, { contextTokens: 4096 });
    assertNoOrphanToolResults(r.messages);
  });
});
