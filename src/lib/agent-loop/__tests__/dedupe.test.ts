import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";

vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentListDir: vi.fn(async () => ({ entries: [], truncated: false })),
      agentClassifyShell: vi.fn(async () => "normal"),
      agentClassifyApplescript: vi.fn(async () => "normal"),
      agentClassifyHttp: vi.fn(async () => "normal"),
      agentCancelShell: vi.fn(async () => {}),
    },
  };
});

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

function ollamaToolCall(id: string, name: string, args: object) {
  return {
    message: {
      content: "",
      tool_calls: [
        { id, type: "function", function: { name, arguments: args } },
      ],
    },
    prompt_eval_count: 1,
    eval_count: 1,
  };
}

function ollamaFinal(text: string) {
  return { message: { content: text }, prompt_eval_count: 1, eval_count: 1 };
}

describe("dedupe", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("two identical tool-call signatures back-to-back trips duplicate_call", async () => {
    const args = { path: "/tmp/somewhere" };
    const responses: object[] = [
      // First identical call — executes normally.
      ollamaToolCall("tc-a", "list_dir", args),
      // Second identical call — should be intercepted as duplicate_call.
      ollamaToolCall("tc-b", "list_dir", args),
      // Final reply so the loop terminates.
      ollamaFinal("done"),
    ];

    let idx = 0;
    const fetchMock = vi.fn(async () => {
      const payload = responses[idx++] ?? ollamaFinal("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "list" }],
      conversationId: 1,
      workspaceRoot: null,
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    const lastSnapshot = collected[collected.length - 1] ?? [];
    const dupMsgs = lastSnapshot.filter((m) => {
      if (m.role !== "tool") return false;
      try {
        const parsed = JSON.parse(m.content);
        return parsed && parsed.kind === "duplicate_call";
      } catch {
        return false;
      }
    });
    expect(dupMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
