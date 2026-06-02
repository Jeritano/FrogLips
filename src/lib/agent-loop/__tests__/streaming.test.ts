import { describe, expect, it, vi } from "vitest";
import { streamOllamaChat } from "../ollama-client";

/**
 * Build a Response whose body is a ReadableStream emitting the given chunks.
 * Each chunk is enqueued as a separate Uint8Array, so the parser must
 * correctly buffer across reads when chunks split mid-line.
 */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("streamOllamaChat", () => {
  it("fires onContentChunk for each content delta and concatenates final content", async () => {
    const lines = [
      JSON.stringify({ message: { content: "Hello, " } }) + "\n",
      JSON.stringify({ message: { content: "world" } }) + "\n",
      JSON.stringify({ message: { content: "!" }, done: true, prompt_eval_count: 5, eval_count: 3 }) + "\n",
    ];
    const fetchMock = vi.fn(async () => streamingResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const result = await streamOllamaChat(
      "http://localhost/api/chat",
      { model: "test" },
      new AbortController().signal,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(["Hello, ", "world", "!"]);
    expect(result.content).toBe("Hello, world!");
    expect(result.tool_calls).toEqual([]);
    expect(result.prompt_eval_count).toBe(5);
    expect(result.eval_count).toBe(3);

    vi.unstubAllGlobals();
  });

  it("merges tool_calls split across multiple chunks by index", async () => {
    // First chunk: tool name. Second chunk: arguments (as a JSON-string fragment).
    // Third: final arg piece + done. Mirrors how Ollama emits tool calls mid-stream.
    const lines = [
      JSON.stringify({
        message: {
          content: "",
          tool_calls: [
            { index: 0, id: "tc-1", type: "function", function: { name: "read_file", arguments: "" } },
          ],
        },
      }) + "\n",
      JSON.stringify({
        message: {
          content: "",
          tool_calls: [
            { index: 0, function: { name: "", arguments: '{"path":"/tmp/' } },
          ],
        },
      }) + "\n",
      JSON.stringify({
        message: {
          content: "",
          tool_calls: [
            { index: 0, function: { name: "", arguments: 'foo.txt"}' } },
          ],
        },
        done: true,
      }) + "\n",
    ];
    const fetchMock = vi.fn(async () => streamingResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOllamaChat(
      "http://localhost/api/chat",
      { model: "test" },
      new AbortController().signal,
      () => {},
    );

    expect(result.tool_calls).toHaveLength(1);
    const tc = result.tool_calls[0];
    expect(tc.id).toBe("tc-1");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("read_file");
    expect(tc.function.arguments).toEqual({ path: "/tmp/foo.txt" });

    vi.unstubAllGlobals();
  });

  it("buffers partial JSON lines that split across chunk boundaries", async () => {
    // Split a single JSON line across two chunks — parser must hold the
    // partial in its buffer and parse once the \n arrives.
    const full = JSON.stringify({ message: { content: "spliced" } }) + "\n";
    const mid = Math.floor(full.length / 2);
    const chunks = [full.slice(0, mid), full.slice(mid)];
    const fetchMock = vi.fn(async () => streamingResponse(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const result = await streamOllamaChat(
      "http://localhost/api/chat",
      { model: "test" },
      new AbortController().signal,
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(["spliced"]);
    expect(result.content).toBe("spliced");

    vi.unstubAllGlobals();
  });
});
