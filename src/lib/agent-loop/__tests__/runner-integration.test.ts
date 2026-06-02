import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import type { AgentMetrics } from "../types";

/**
 * Runner-level integration coverage. The other agent-loop tests exercise
 * individual helpers; this drives the assembled `runAgentLoop` through a full
 * multi-iteration cycle: iteration 1 the model emits a tool call, iteration 2
 * (after the tool result is fed back) it emits final text and stops.
 *
 * The Ollama backend is driven by stubbing `fetch` with a scripted sequence
 * of NDJSON responses — the same approach `dedupe.test.ts` uses. `api` is
 * mocked so tool dispatch, audit recording and session metrics are all
 * observable.
 */

const { auditMock, metricsMock, listDirMock } = vi.hoisted(() => ({
  auditMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
  metricsMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
  listDirMock: vi.fn(async () => ({ entries: ["a.txt", "b.txt"], truncated: false })),
}));

vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentListDir: listDirMock,
      agentClassifyShell: vi.fn(async () => "normal"),
      agentClassifyApplescript: vi.fn(async () => "normal"),
      agentClassifyHttp: vi.fn(async () => "normal"),
      agentCancelShell: vi.fn(async () => {}),
      agentAuditRecord: auditMock,
      agentSessionMetricsRecord: metricsMock,
    },
  };
});

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

/** One Ollama /api/chat response carrying a single tool call. */
function ollamaToolCall(id: string, name: string, args: object) {
  return {
    message: {
      content: "",
      tool_calls: [
        { id, type: "function", function: { name, arguments: args } },
      ],
    },
    prompt_eval_count: 7,
    eval_count: 3,
  };
}

/** One Ollama /api/chat response carrying a final text reply. */
function ollamaFinal(text: string) {
  return { message: { content: text }, prompt_eval_count: 5, eval_count: 9 };
}

/** Build a scripted `fetch` mock: each call returns the next payload, then
 *  falls back to a final reply once the script is exhausted. */
function scriptedFetch(responses: object[]) {
  let idx = 0;
  return vi.fn(async () => {
    const payload = responses[idx++] ?? ollamaFinal("done");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function baseOpts(collected: Message[][], metrics: { last: AgentMetrics | null }): AgentRunOptions {
  return {
    model: "test",
    messages: [{ conversation_id: 1, role: "user", content: "list the dir" }],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: (m) => collected.push([...m]),
    onStatusChange: () => {},
    onMetrics: (m) => { metrics.last = { ...m }; },
    requestConfirmation: async () => ({ approve: true }),
    signal: new AbortController().signal,
  };
}

describe("runAgentLoop integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auditMock.mockClear();
    metricsMock.mockClear();
    listDirMock.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("drives a full tool-call → result → final-text cycle", async () => {
    const fetchMock = scriptedFetch([
      // Iteration 1: model asks to run list_dir.
      ollamaToolCall("tc-1", "list_dir", { path: "/tmp/work" }),
      // Iteration 2: after the tool result is fed back, model answers.
      ollamaFinal("The directory contains a.txt and b.txt."),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    // The loop terminated with the model's final text.
    expect(result).toBe("The directory contains a.txt and b.txt.");

    // The tool was actually dispatched.
    expect(listDirMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).toHaveBeenCalledWith("/tmp/work");

    // The tool result was appended as a role:"tool" message.
    const lastSnapshot = collected[collected.length - 1] ?? [];
    const toolMsgs = lastSnapshot.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool_call_id).toBe("tc-1");
    expect(toolMsgs[0].tool_name).toBe("list_dir");
    expect(toolMsgs[0].content).toContain("a.txt");

    // The final assistant message carries the answer text.
    const finalAsst = lastSnapshot.filter(
      (m) => m.role === "assistant" && !m.tool_calls,
    );
    expect(finalAsst[finalAsst.length - 1]?.content).toBe(
      "The directory contains a.txt and b.txt.",
    );

    // Metrics were recorded: two LLM iterations, one tool call.
    expect(metrics.last?.iterations).toBe(2);
    expect(metrics.last?.toolCalls).toBe(1);
    expect(metrics.last?.promptTokens).toBe(12); // 7 + 5

    // Audit recording happened per branch — one row for the dispatched tool.
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditEntry = auditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditEntry.tool_name).toBe("list_dir");
    expect(auditEntry.outcome).toBe("ok");

    // A session-metrics row was written exactly once on exit.
    expect(metricsMock).toHaveBeenCalledTimes(1);
  });

  it("terminates at MAX_ITERATIONS when the model never stops calling tools", async () => {
    // Every fetch returns a tool call — but each carries unique args so the
    // dedupe guard never short-circuits the loop. The runner must instead
    // hit the iteration cap.
    let n = 0;
    const fetchMock = vi.fn(async () => {
      const payload = ollamaToolCall(`tc-${n}`, "list_dir", { path: `/tmp/d${n}` });
      n++;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    // The cap path returns null and appends the explanatory cap message.
    expect(result).toBeNull();
    const lastSnapshot = collected[collected.length - 1] ?? [];
    const capMsg = lastSnapshot[lastSnapshot.length - 1];
    expect(capMsg?.role).toBe("assistant");
    expect(capMsg?.content).toContain("maximum iteration limit");

    // The loop ran the full budget of iterations.
    expect(metrics.last?.iterations).toBe(40);
    // Session metrics still recorded exactly once on the cap exit.
    expect(metricsMock).toHaveBeenCalledTimes(1);
  });
});
