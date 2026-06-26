import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import { isToolStalling } from "../runner-helpers";

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

describe("isToolStalling (per-tool keying)", () => {
  // STALL_SAME_PATH_LIMIT = 6, so the 7th identical call trips the guard.
  it("counts read_files by its joined path set (L21) and tags the right tool", () => {
    const counts = new Map<string, number>();
    let last = { stalling: false, key: "", count: 0, tool: "" };
    for (let i = 0; i < 7; i++) {
      last = isToolStalling("read_files", { paths: ["a.ts", "b.ts"] }, counts);
    }
    expect(last.stalling).toBe(true);
    expect(last.tool).toBe("read_files"); // L17: message must name the real tool
    // A different path set is tracked independently and does not stall.
    expect(isToolStalling("read_files", { paths: ["c.ts"] }, counts).stalling).toBe(
      false,
    );
  });

  it("counts read_pdf by path", () => {
    const counts = new Map<string, number>();
    let last = { stalling: false, key: "", count: 0, tool: "" };
    for (let i = 0; i < 7; i++) {
      last = isToolStalling("read_pdf", { path: "x.pdf" }, counts);
    }
    expect(last.stalling).toBe(true);
    expect(last.tool).toBe("read_pdf");
  });

  it("does not flag tools outside the read/search family", () => {
    const counts = new Map<string, number>();
    expect(
      isToolStalling("apply_patch", { path: "x" }, counts).stalling,
    ).toBe(false);
  });
});
