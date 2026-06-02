import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../mlx-client";
import type { ServerStatus } from "../../types";

/**
 * Build a Response whose body is a ReadableStream emitting the given chunks
 * as separate Uint8Arrays — so the SSE line buffer must reassemble lines
 * that split across reads.
 */
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

const STATUS: ServerStatus = {
  running: true,
  ready: true,
  model: "test-model",
  backend: "mlx",
  host: "localhost",
  port: 1234,
};

function dataLine(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

async function drain(gen: AsyncGenerator<{ delta: string; done: boolean }>) {
  const deltas: string[] = [];
  let sawDone = false;
  for await (const c of gen) {
    if (c.delta) deltas.push(c.delta);
    if (c.done) sawDone = true;
  }
  return { deltas, sawDone };
}

describe("streamChat — SSE line buffering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses one delta per data: line and stops at [DONE]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([dataLine("Hello, "), dataLine("world"), "data: [DONE]\n"]),
      ),
    );
    const { deltas, sawDone } = await drain(streamChat(STATUS, []));
    expect(deltas.join("")).toBe("Hello, world");
    expect(sawDone).toBe(true);
  });

  it("reassembles a data: line split across two read chunks", async () => {
    const full = dataLine("split-token");
    const mid = Math.floor(full.length / 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([full.slice(0, mid), full.slice(mid), "data: [DONE]\n"]),
      ),
    );
    const { deltas } = await drain(streamChat(STATUS, []));
    expect(deltas.join("")).toBe("split-token");
  });

  it("ignores blank lines, comments and malformed JSON keepalives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          "\n",
          ": keepalive comment\n",
          "data: {not json}\n",
          dataLine("real"),
          "data: [DONE]\n",
        ]),
      ),
    );
    const { deltas } = await drain(streamChat(STATUS, []));
    expect(deltas.join("")).toBe("real");
  });

  it("handles [DONE] arriving in the same chunk as a content line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([dataLine("end") + "data: [DONE]\n"])),
    );
    const { deltas, sawDone } = await drain(streamChat(STATUS, []));
    expect(deltas.join("")).toBe("end");
    expect(sawDone).toBe(true);
  });

  it("terminates cleanly when the stream ends without an explicit [DONE]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([dataLine("partial")])),
    );
    const { deltas, sawDone } = await drain(streamChat(STATUS, []));
    expect(deltas.join("")).toBe("partial");
    expect(sawDone).toBe(true);
  });
});
