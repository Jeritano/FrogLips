import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ServerStatus } from "../../../types";

/**
 * Coverage for the `backend:"mlx"` path through the agent loop.
 *
 * The runner is otherwise only exercised with Ollama-shaped NDJSON fetch
 * mocks; this drives `streamMlxAgentChat` (via `streamAgentChat`) with an
 * MLX/OpenAI-compatible SSE stream — including piecewise `tool_calls`
 * deltas and a trailing `usage` block — and asserts tool calls are parsed,
 * dispatched, and token usage is surfaced.
 */

vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentListDir: vi.fn(async () => ({
        entries: ["a.txt"],
        truncated: false,
      })),
      agentClassifyShell: vi.fn(async () => "normal"),
      agentClassifyApplescript: vi.fn(async () => "normal"),
      agentClassifyHttp: vi.fn(async () => "normal"),
      agentCancelShell: vi.fn(async () => {}),
      agentAuditRecord: vi.fn(async () => {}),
      agentSessionMetricsRecord: vi.fn(async () => {}),
    },
  };
});

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";
import { streamMlxAgentChat } from "../../mlx-client";

const STATUS: ServerStatus = {
  running: true,
  ready: true,
  model: "mlx-test-model",
  backend: "mlx",
  host: "localhost",
  port: 4321,
};

/** Build a Response whose body streams the given chunks as separate
 *  Uint8Arrays — so the SSE line buffer must reassemble split lines. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** One OpenAI-style SSE `data:` frame. */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("streamMlxAgentChat — tool_calls delta parsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("merges piecewise tool_calls deltas and extracts usage tokens", async () => {
    const frames = [
      // Slot 0: name + opening of the JSON args (string fragment).
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "list_dir", arguments: '{"path":"/t' },
                },
              ],
            },
          },
        ],
      }),
      // Slot 0: remaining args fragment.
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'mp"}' } }],
            },
          },
        ],
      }),
      // Final frame carries the usage block.
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(frames)),
    );

    const result = await streamMlxAgentChat(
      STATUS,
      [{ conversation_id: 1, role: "user", content: "list" }],
      [],
      new AbortController().signal,
      () => {},
    );

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].function.name).toBe("list_dir");
    expect(result.tool_calls[0].function.arguments).toEqual({ path: "/tmp" });
    expect(result.prompt_eval_count).toBe(11);
    expect(result.eval_count).toBe(7);
  });
});

describe("runAgentLoop — backend:'mlx'", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses and dispatches an MLX tool call, then completes on the next turn", async () => {
    // Turn 1: SSE stream issuing a list_dir tool call.
    // Turn 2: SSE stream with a plain-text final reply (no tool calls).
    const turn1 = [
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tc-1",
                  type: "function",
                  function: { name: "list_dir", arguments: '{"path":"/tmp"}' },
                },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      "data: [DONE]\n\n",
    ];
    const turn2 = [
      sse({ choices: [{ index: 0, delta: { content: "All done." } }] }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }),
      "data: [DONE]\n\n",
    ];

    const turns = [turn1, turn2];
    let turnIdx = 0;
    const fetchMock = vi.fn(async () => sseResponse(turns[turnIdx++] ?? turn2));
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const opts: AgentRunOptions = {
      model: "mlx-test-model",
      messages: [{ conversation_id: 1, role: "user", content: "list /tmp" }],
      conversationId: 1,
      workspaceRoot: null,
      backend: "mlx",
      serverStatus: STATUS,
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    const final = await runAgentLoop(opts);

    // Two streaming turns were requested against the MLX endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown[];
    expect(String(firstCall[0])).toContain("/v1/chat/completions");

    // The list_dir tool call was dispatched — a `tool` message with the
    // dispatcher's result is present in the final transcript.
    const last = collected[collected.length - 1] ?? [];
    const toolMsg = last.find(
      (m) => m.role === "tool" && m.tool_name === "list_dir",
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("tc-1");
    const parsed = JSON.parse(toolMsg!.content);
    expect(parsed.entries).toEqual(["a.txt"]);

    // The loop terminated with the second-turn plain-text reply.
    expect(final).toBe("All done.");
  });

  it("terminates with the iteration-cap message when the model never stops calling tools", async () => {
    // Every turn emits a list_dir call against a UNIQUE path so the
    // duplicate-call / stall guards never trip — the loop can only end
    // by hitting MAX_ITERATIONS.
    let turn = 0;
    const fetchMock = vi.fn(async () => {
      const path = `/tmp/iter-${turn++}`;
      return sseResponse([
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `tc-${turn}`,
                    type: "function",
                    function: {
                      name: "list_dir",
                      arguments: JSON.stringify({ path }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        sse({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
        "data: [DONE]\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const opts: AgentRunOptions = {
      model: "mlx-test-model",
      messages: [{ conversation_id: 1, role: "user", content: "loop forever" }],
      conversationId: 1,
      // Small turn budget so the cap-path test stays fast + deterministic.
      maxIterations: 8,
      workspaceRoot: null,
      backend: "mlx",
      serverStatus: STATUS,
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    const final = await runAgentLoop(opts);

    // The loop returns null (no completion) on hitting the cap.
    expect(final).toBeNull();
    // The final transcript carries the iteration-limit assistant message.
    const last = collected[collected.length - 1] ?? [];
    const capMsg = last.find(
      (m) => m.role === "assistant" && /turn limit/i.test(m.content),
    );
    expect(capMsg).toBeDefined();
  });
});
