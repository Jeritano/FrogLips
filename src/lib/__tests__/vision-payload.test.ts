import { describe, expect, it, vi } from "vitest";
import { toOllamaMessages } from "../agent-loop/ollama-client";
import { streamOllamaChat } from "../agent-loop/ollama-client";
import { streamChat } from "../mlx-client";
import type { ChatImage, Message, ServerStatus } from "../../types";

const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==";

function visionMsg(text: string, base64 = PIXEL_PNG_B64): Message {
  const img: ChatImage = {
    base64,
    mime: "image/png",
    filename: "pixel.png",
    size_bytes: 67,
  };
  return {
    conversation_id: 1,
    role: "user",
    content: text,
    images: [img],
  };
}

describe("toOllamaMessages — vision payload shape", () => {
  it("appends images: [base64] alongside content for user turns with attachments", () => {
    const out = toOllamaMessages([visionMsg("what's this?")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "user",
      content: "what's this?",
      images: [PIXEL_PNG_B64],
    });
    // Critical: must be raw base64, never a data: URL prefix
    const imgArr = (out[0] as { images?: string[] }).images!;
    expect(imgArr[0].startsWith("data:")).toBe(false);
  });

  it("leaves text-only user turns untouched (no images key)", () => {
    const out = toOllamaMessages([
      { conversation_id: 1, role: "user", content: "plain" },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "plain" });
    expect("images" in (out[0] as object)).toBe(false);
  });

  it("supports multiple images on a single message", () => {
    const m = visionMsg("two pics");
    m.images = [
      { base64: "AAAA", mime: "image/png", size_bytes: 3 },
      { base64: "BBBB", mime: "image/png", size_bytes: 3 },
    ];
    const out = toOllamaMessages([m]) as Array<{ images?: string[] }>;
    expect(out[0].images).toEqual(["AAAA", "BBBB"]);
  });
});

/**
 * Integration-style: stand up streamOllamaChat against a stubbed fetch,
 * feed it a user message with images, and assert the request body the
 * client actually serialised carried the images array verbatim.
 */
describe("streamOllamaChat — request body carries images", () => {
  function streamingResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("includes images in the outgoing Ollama request body", async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return streamingResponse([
        JSON.stringify({ message: { content: "I see a pixel." }, done: true }) + "\n",
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOllamaChat(
      "http://localhost/api/chat",
      {
        model: "llava:13b",
        messages: toOllamaMessages([visionMsg("describe")]),
      },
      new AbortController().signal,
      () => {},
    );

    expect(result.content).toBe("I see a pixel.");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.messages[0].images).toEqual([PIXEL_PNG_B64]);
    expect(capturedBody.messages[0].content).toBe("describe");
    vi.unstubAllGlobals();
  });
});

describe("streamChat (MLX/OpenAI-compat) — multi-content image payload", () => {
  it("wraps text + image into the OpenAI multi-content array shape", async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status: ServerStatus = {
      running: true,
      ready: true,
      model: "qwen2-vl-7b",
      backend: "mlx",
      host: "127.0.0.1",
      port: 18080,
    };

    const gen = streamChat(status, [visionMsg("describe this")], {});
    // Drain so the request fires
    for await (const _ of gen) { /* noop */ }

    expect(capturedBody).not.toBeNull();
    const content = capturedBody.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "describe this" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${PIXEL_PNG_B64}`);
    vi.unstubAllGlobals();
  });

  it("falls back to plain-string content when the message has no images", async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status: ServerStatus = {
      running: true, ready: true, model: "qwen2:7b",
      backend: "mlx", host: "127.0.0.1", port: 18080,
    };
    const gen = streamChat(
      status,
      [{ conversation_id: 1, role: "user", content: "plain" }],
      {},
    );
    for await (const _ of gen) { /* noop */ }

    expect(capturedBody.messages[0].content).toBe("plain");
    vi.unstubAllGlobals();
  });
});
