import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import type { AgentMetrics } from "../types";

/**
 * Coverage for two paths that previously had only inline runtime logic and no
 * test:
 *
 *   1. H-A2 — `*:cloud` Ollama route: when the model returns >1 tool_call
 *      in a single turn we MUST execute only the first and inject a
 *      synthetic `[agent-loop] Cloud-route only executes ONE tool call` system
 *      reminder so the model reissues the rest. Without this gate the
 *      cloud gateway 400s the next request with the "object … can't find
 *      closing '}'" body shape error.
 *
 *   2. M-A4 — research-nudge: when an agent makes ≥ RESEARCH_NUDGE_THRESHOLD
 *      external research calls (`web_search`/`web_fetch`/`read_pdf`) without
 *      ever calling `write_file`/`edit_file`/`multi_edit`, the runner injects
 *      a one-time `STOP RESEARCHING` system reminder telling the model to
 *      ship the deliverable. Fires once per run.
 *
 * Both paths are driven through the assembled `runAgentLoop` so the test
 * exercises the real iteration counter, audit hooks and metrics. The Ollama
 * backend is faked via `vi.stubGlobal("fetch")` with a scripted response
 * sequence — the same approach `runner-integration.test.ts` already uses.
 */

const { auditMock, metricsMock, listDirMock, webSearchMock } = vi.hoisted(() => ({
  auditMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
  metricsMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
  listDirMock: vi.fn(async () => ({ entries: ["a.txt"], truncated: false })),
  webSearchMock: vi.fn(async () => ({
    results: [{ title: "stub", url: "https://example.test/", snippet: "stub" }],
  })),
}));

vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentListDir: listDirMock,
      agentWebSearch: webSearchMock,
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

/** Ollama /api/chat reply carrying N parallel tool calls. */
function ollamaParallelToolCalls(
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

/** Ollama /api/chat reply carrying a single tool call. */
function ollamaToolCall(id: string, name: string, args: object) {
  return ollamaParallelToolCalls([{ id, name, args }]);
}

/** Ollama /api/chat reply carrying final text. */
function ollamaFinal(text: string) {
  return { message: { content: text }, prompt_eval_count: 4, eval_count: 5 };
}

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
  model: string,
  collected: Message[][],
  metrics: { last: AgentMetrics | null },
  extra: Partial<AgentRunOptions> = {},
): AgentRunOptions {
  return {
    model,
    messages: [{ conversation_id: 1, role: "user", content: "go" }],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: (m) => collected.push([...m]),
    onStatusChange: () => {},
    onMetrics: (m) => {
      metrics.last = { ...m };
    },
    requestConfirmation: async () => ({ approve: true }),
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("runAgentLoop — cloud parallel-call drop (H-A2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auditMock.mockClear();
    metricsMock.mockClear();
    listDirMock.mockClear();
    webSearchMock.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("on *:cloud routes only the first of 3 parallel tool_calls runs", async () => {
    // Iteration 1: cloud model issues THREE parallel tool calls.
    // Iteration 2 (after the first tool result is fed back): model says done.
    const fetchMock = scriptedFetch([
      ollamaParallelToolCalls([
        { id: "tc-1", name: "list_dir", args: { path: "/tmp/one" } },
        { id: "tc-2", name: "list_dir", args: { path: "/tmp/two" } },
        { id: "tc-3", name: "list_dir", args: { path: "/tmp/three" } },
      ]),
      ollamaFinal("ok"),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(
      baseOpts("test:cloud", collected, metrics),
    );

    expect(result).toBe("ok");
    // Only ONE list_dir actually ran. The other two were truncated by the
    // cloud-route gate; the model is expected to reissue them on a later turn.
    expect(listDirMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).toHaveBeenCalledWith("/tmp/one");

    // The synthetic system reminder MUST appear in the final message array so
    // the next turn's prompt carries it.
    const finalMsgs = collected[collected.length - 1] ?? [];
    const reminder = finalMsgs.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("Cloud-route only executes ONE tool call"),
    );
    expect(reminder).toBeDefined();
    expect(reminder?.content).toContain("2 additional tool call(s)");
  });

  it("local (non-:cloud) routes execute all parallel tool_calls", async () => {
    const fetchMock = scriptedFetch([
      ollamaParallelToolCalls([
        { id: "tc-1", name: "list_dir", args: { path: "/tmp/one" } },
        { id: "tc-2", name: "list_dir", args: { path: "/tmp/two" } },
      ]),
      ollamaFinal("ok"),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(
      baseOpts("local-llama", collected, metrics),
    );

    expect(result).toBe("ok");
    // Both calls ran — no drop on local backend.
    expect(listDirMock).toHaveBeenCalledTimes(2);
    // No cloud-route reminder injected.
    const finalMsgs = collected[collected.length - 1] ?? [];
    const reminder = finalMsgs.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("Cloud-route only executes ONE tool call"),
    );
    expect(reminder).toBeUndefined();
  });
});

describe("runAgentLoop — research-nudge (M-A4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auditMock.mockClear();
    metricsMock.mockClear();
    listDirMock.mockClear();
    webSearchMock.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("injects STOP RESEARCHING after 10 web_search calls + 0 writes", async () => {
    // 10 iterations of web_search, then a final text reply so the loop exits.
    // The nudge fires on the iteration where researchCallCount HITS the
    // threshold — after the 10th tool result, before the next LLM turn.
    const tenSearches = Array.from({ length: 10 }, (_, i) =>
      ollamaToolCall(`tc-${i}`, "web_search", { query: `q${i}` }),
    );
    const fetchMock = scriptedFetch([...tenSearches, ollamaFinal("done")]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(
      baseOpts("local-llama", collected, metrics, {
        // Allowlist must include a writable tool so `canWriteFile` is true —
        // otherwise the runner silently skips the nudge (no point telling a
        // card without write capability to "write the file").
        toolAllowlist: ["web_search", "write_file"],
      }),
    );

    expect(result).toBe("done");
    expect(webSearchMock).toHaveBeenCalledTimes(10);

    // Verify the nudge landed in the final message snapshot.
    const finalMsgs = collected[collected.length - 1] ?? [];
    const nudges = finalMsgs.filter(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("STOP RESEARCHING"),
    );
    // Fires exactly once per run, regardless of how many subsequent turns
    // also satisfy the threshold.
    expect(nudges.length).toBe(1);
    expect(nudges[0].content).toContain("10 research calls");
  });

  it("does NOT inject the nudge when canWriteFile is false", async () => {
    // Same 10-search trace, but the allowlist has NO writable tool, so the
    // runner correctly skips the nudge — telling a research-only card to
    // commit a file would be nonsense.
    const tenSearches = Array.from({ length: 10 }, (_, i) =>
      ollamaToolCall(`tc-${i}`, "web_search", { query: `q${i}` }),
    );
    const fetchMock = scriptedFetch([...tenSearches, ollamaFinal("done")]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(
      baseOpts("local-llama", collected, metrics, {
        toolAllowlist: ["web_search"],
      }),
    );

    expect(result).toBe("done");
    const finalMsgs = collected[collected.length - 1] ?? [];
    const nudges = finalMsgs.filter(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("STOP RESEARCHING"),
    );
    expect(nudges.length).toBe(0);
  });

  it("does NOT inject the nudge when fewer than 10 research calls have run", async () => {
    // Three searches + final reply — under threshold.
    const threeSearches = Array.from({ length: 3 }, (_, i) =>
      ollamaToolCall(`tc-${i}`, "web_search", { query: `q${i}` }),
    );
    const fetchMock = scriptedFetch([...threeSearches, ollamaFinal("done")]);
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(
      baseOpts("local-llama", collected, metrics, {
        toolAllowlist: ["web_search", "write_file"],
      }),
    );

    expect(result).toBe("done");
    const finalMsgs = collected[collected.length - 1] ?? [];
    const nudges = finalMsgs.filter(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("STOP RESEARCHING"),
    );
    expect(nudges.length).toBe(0);
  });
});
