import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";

// Mock the tauri-api module — agentReadFile must not actually try to invoke
// Tauri, and the classifier hooks need to return without throwing.
vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentReadFile: vi.fn(async () => ({
        content: "x",
        bytes_read: 1,
        total_bytes: 1,
        truncated: false,
        binary: false,
      })),
      agentClassifyShell: vi.fn(async () => "normal"),
      agentClassifyApplescript: vi.fn(async () => "normal"),
      agentClassifyHttp: vi.fn(async () => "normal"),
      agentCancelShell: vi.fn(async () => {}),
    },
  };
});

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

/** Build a fake Ollama response with one tool call. */
function ollamaToolCallResponse(id: string, name: string, args: object) {
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

function ollamaFinalResponse(text: string) {
  return { message: { content: text }, prompt_eval_count: 1, eval_count: 1 };
}

describe("stall guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("7th identical read_file emits a stall_guard tool message", async () => {
    let callIdx = 0;
    const responses: object[] = [];
    // Vary the tool_call id so the dedupe path isn't triggered first.
    for (let i = 0; i < 7; i++) {
      responses.push(
        ollamaToolCallResponse(`tc-${i}`, "read_file", {
          path: "/tmp/foo.txt",
          offset: i * 1024,
          limit: 1024,
        }),
      );
    }
    // After the 7th tool call result is returned, the model says "done".
    responses.push(ollamaFinalResponse("done"));

    const fetchMock = vi.fn(async () => {
      const payload = responses[callIdx++] ?? ollamaFinalResponse("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "read it" }],
      conversationId: 1,
      workspaceRoot: null,
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    // Flatten all tool messages observed and find any stall_guard.
    const lastSnapshot = collected[collected.length - 1] ?? [];
    const toolMsgs = lastSnapshot.filter((m) => m.role === "tool");
    const stallMsgs = toolMsgs.filter((m) => {
      try {
        const parsed = JSON.parse(m.content);
        return parsed && parsed.kind === "stall_guard";
      } catch {
        return false;
      }
    });
    expect(stallMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
