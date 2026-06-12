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
  listDirMock: vi.fn(async (_path: string) => ({
    entries: ["a.txt", "b.txt"],
    truncated: false as boolean,
  })),
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

/** One Ollama /api/chat response carrying SEVERAL tool calls in one turn. */
function ollamaMultiToolCall(
  calls: Array<{ id: string; name: string; args: object }>,
) {
  return {
    message: {
      content: "",
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args },
      })),
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

function baseOpts(
  collected: Message[][],
  metrics: { last: AgentMetrics | null },
): AgentRunOptions {
  return {
    model: "test",
    messages: [{ conversation_id: 1, role: "user", content: "list the dir" }],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: (m) => collected.push([...m]),
    onStatusChange: () => {},
    onMetrics: (m) => {
      metrics.last = { ...m };
    },
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

  it("streams text only via onAssistantDelta; onUpdate is structural-only (perf C1)", async () => {
    // Multi-chunk NDJSON final reply — exercises the per-delta path. The old
    // design pushed an in-place-mutated placeholder through onUpdate per
    // flush: invisible to the memoized row (same object identity) yet
    // re-rendering the history every frame. The contract is now: deltas →
    // onAssistantDelta, onUpdate ONLY when a canonical message lands.
    const chunks = ["The ", "answer ", "is 42."];
    const body =
      chunks
        .map((c) => JSON.stringify({ message: { content: c } }))
        .join("\n") +
      "\n" +
      JSON.stringify({
        message: { content: "" },
        done: true,
        prompt_eval_count: 5,
        eval_count: 9,
      }) +
      "\n";
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const deltas: string[] = [];
    const opts = baseOpts(collected, metrics);
    opts.onAssistantDelta = (d) => deltas.push(d);
    const result = await runAgentLoop(opts);

    // Every delta arrived raw, in order, and concatenates to the final text.
    expect(deltas.join("")).toBe("The answer is 42.");
    expect(result).toBe("The answer is 42.");

    // No onUpdate snapshot ever contained an in-flight partial: every
    // assistant message in every snapshot is either complete final text or a
    // canonical tool-call turn — never a growing prefix of the reply.
    for (const snap of collected) {
      for (const m of snap) {
        if (m.role !== "assistant") continue;
        expect(
          m.content === "The answer is 42." || (m.tool_calls?.length ?? 0) > 0,
        ).toBe(true);
      }
    }
    // Exactly one structural update for a no-tool run: the final message.
    expect(collected.length).toBe(1);
  });

  it("terminates at MAX_ITERATIONS when the model never stops calling tools", async () => {
    // Every fetch returns a tool call — but each carries unique args so the
    // dedupe guard never short-circuits the loop. The runner must instead
    // hit the iteration cap.
    let n = 0;
    const fetchMock = vi.fn(async () => {
      const payload = ollamaToolCall(`tc-${n}`, "list_dir", {
        path: `/tmp/d${n}`,
      });
      n++;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop({
      ...baseOpts(collected, metrics),
      // Small budget so the cap path is fast + deterministic (also exercises
      // the new per-run maxIterations override).
      maxIterations: 8,
    });

    // The cap path returns null and appends the explanatory cap message.
    expect(result).toBeNull();
    const lastSnapshot = collected[collected.length - 1] ?? [];
    const capMsg = lastSnapshot[lastSnapshot.length - 1];
    expect(capMsg?.role).toBe("assistant");
    expect(capMsg?.content).toContain("turn limit");

    // The loop ran the full (overridden) budget of iterations.
    expect(metrics.last?.iterations).toBe(8);
    // Session metrics still recorded exactly once on the cap exit.
    expect(metricsMock).toHaveBeenCalledTimes(1);
  });

  it("executes a multi read-only turn in parallel, preserving result order (opt #1)", async () => {
    // Turn 1 issues THREE read-only list_dir calls at once. The runner's
    // prefetch fires them concurrently; the serial loop then lands their
    // results in tool-call order. Make the mock resolve out of order (the
    // first call resolves LAST) so a serial implementation would still pass
    // but the ordering assertion specifically guards the concurrent path.
    const order: string[] = [];
    listDirMock.mockImplementation(async (path: string) => {
      order.push(`start:${path}`);
      // First-issued path resolves on a later microtask tick than the others.
      const delay = path.endsWith("a") ? 3 : 1;
      await new Promise((r) => setTimeout(r, delay));
      order.push(`done:${path}`);
      return { entries: [`${path}-entry`], truncated: false };
    });

    const fetchMock = scriptedFetch([
      ollamaMultiToolCall([
        { id: "p-1", name: "list_dir", args: { path: "/dir/a" } },
        { id: "p-2", name: "list_dir", args: { path: "/dir/b" } },
        { id: "p-3", name: "list_dir", args: { path: "/dir/c" } },
      ]),
      ollamaFinal("listed all three"),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    expect(result).toBe("listed all three");
    expect(listDirMock).toHaveBeenCalledTimes(3);

    // Concurrency proof: all three started before the first one finished.
    const firstDoneIdx = order.indexOf("done:/dir/a");
    const startsBeforeFirstDone = order
      .slice(0, firstDoneIdx)
      .filter((e) => e.startsWith("start:")).length;
    expect(startsBeforeFirstDone).toBe(3);

    // Ordering proof: the three tool results appear in tool-call order.
    const last = collected[collected.length - 1] ?? [];
    const toolResults = last.filter((m) => m.role === "tool");
    expect(toolResults.map((m) => m.tool_call_id)).toEqual([
      "p-1",
      "p-2",
      "p-3",
    ]);
    expect(toolResults[0].content).toContain("/dir/a-entry");
    expect(toolResults[2].content).toContain("/dir/c-entry");
  });

  it("flags an A/B/A oscillation as a duplicate via the widened dedupe window (opt #2)", async () => {
    // Old one-turn-back dedupe never caught A,B,A. The 3-turn history does:
    // turn 3's list_dir(/x) matches turn 1's, so it is rejected as a dup
    // instead of executing a third time.
    const fetchMock = scriptedFetch([
      ollamaToolCall("a-1", "list_dir", { path: "/x" }), // turn 1: A
      ollamaToolCall("b-1", "list_dir", { path: "/y" }), // turn 2: B
      ollamaToolCall("a-2", "list_dir", { path: "/x" }), // turn 3: A again
      ollamaFinal("done oscillating"),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    expect(result).toBe("done oscillating");
    // list_dir(/x) executed only ONCE (turn 1); turn 3's repeat was rejected,
    // plus list_dir(/y) once → two real dispatches total.
    expect(listDirMock).toHaveBeenCalledTimes(2);

    const last = collected[collected.length - 1] ?? [];
    const dup = last.find((m) => m.role === "tool" && m.tool_call_id === "a-2");
    expect(dup).toBeDefined();
    expect(JSON.parse(dup!.content).kind).toBe("duplicate_call");
  });
});
