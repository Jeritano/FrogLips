import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import {
  agentBackendUnsupportedReason,
  streamAgentChat,
} from "../agent-chat";
import { RETRY_MAX } from "../ollama-client";
import type { AgentRunOptions } from "../types";

/** NDJSON Response carrying a single Ollama final-message line. */
function ndjsonResponse(text: string): Response {
  const body = JSON.stringify({ message: { content: text } }) + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

/** Minimal AgentRunOptions for a streamAgentChat call. */
function baseOpts(): AgentRunOptions {
  return {
    model: "test-model",
    messages: [],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: () => {},
    onStatusChange: () => {},
    requestConfirmation: async () => ({ approve: true }),
    signal: new AbortController().signal,
  };
}

const MSGS: Message[] = [{ conversation_id: 1, role: "user", content: "hi" }];

describe("agentBackendUnsupportedReason", () => {
  it("returns null for every backend — all support agent mode", () => {
    expect(agentBackendUnsupportedReason("ollama")).toBeNull();
    expect(agentBackendUnsupportedReason("mlx")).toBeNull();
    expect(agentBackendUnsupportedReason("native")).toBeNull();
  });
});

describe("streamAgentChat — retry / backoff predicate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Advance fake timers concurrently with the in-flight promise so backoff
   *  `setTimeout`s resolve. The promise is created before timers advance so a
   *  synchronous rejection is never left unhandled. */
  function runWithTimers<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    return vi.runAllTimersAsync().then(() =>
      settled.then((r) => (r.ok ? r.v : Promise.reject(r.e))),
    );
  }

  it("retries a 5xx error and succeeds on a later attempt", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response("upstream exploded", { status: 503 });
      }
      return ndjsonResponse("recovered");
    });
    vi.stubGlobal("fetch", fetchMock);

    let retries = 0;
    const result = await runWithTimers(
      streamAgentChat(baseOpts(), MSGS, [], new AbortController().signal, () => {}, () => {
        retries++;
      }),
    );

    expect(result.content).toBe("recovered");
    expect(retries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a bare connection TypeError (no HTTP status)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) throw new TypeError("Failed to fetch");
      return ndjsonResponse("connected");
    });
    vi.stubGlobal("fetch", fetchMock);

    let retries = 0;
    const result = await runWithTimers(
      streamAgentChat(baseOpts(), MSGS, [], new AbortController().signal, () => {}, () => {
        retries++;
      }),
    );

    expect(result.content).toBe("connected");
    expect(retries).toBe(1);
  });

  it("does NOT retry a 4xx error — propagates immediately", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    let retries = 0;
    await expect(
      runWithTimers(
        streamAgentChat(baseOpts(), MSGS, [], new AbortController().signal, () => {}, () => {
          retries++;
        }),
      ),
    ).rejects.toThrow(/400/);
    expect(retries).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after RETRY_MAX retries on persistent 5xx", async () => {
    const fetchMock = vi.fn(async () => new Response("still down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    let retries = 0;
    await expect(
      runWithTimers(
        streamAgentChat(baseOpts(), MSGS, [], new AbortController().signal, () => {}, () => {
          retries++;
        }),
      ),
    ).rejects.toThrow(/500/);
    // Initial attempt + RETRY_MAX retries.
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_MAX + 1);
    expect(retries).toBe(RETRY_MAX);
  });

  it("does not retry once the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchMock = vi.fn(async () => ndjsonResponse("unused"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runWithTimers(
        streamAgentChat(baseOpts(), MSGS, [], ac.signal, () => {}, () => {}),
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the mlx backend when no serverStatus is provided", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse("unused"));
    vi.stubGlobal("fetch", fetchMock);

    const opts = { ...baseOpts(), backend: "mlx" as const, serverStatus: null };
    await expect(
      runWithTimers(
        streamAgentChat(opts, MSGS, [], new AbortController().signal, () => {}, () => {}),
      ),
    ).rejects.toThrow(/MLX backend/i);
  });
});
