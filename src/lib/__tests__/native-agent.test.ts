import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";

/**
 * Coverage for `streamNativeAgentChat` — the native (mistralrs) agent path.
 *
 * The native runtime streams text via `native-chunk:*` events and returns
 * whole tool calls via a single `native-toolcalls:*` event. These tests
 * mock the Tauri event bus + `nativeChatStream` command and assert the
 * resulting `StreamChatResult` matches the Ollama/MLX shape.
 */

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: Handler) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
}));

const nativeChatStream = vi.fn();
vi.mock("../tauri-api", () => ({ api: { nativeChatStream: (...a: unknown[]) => nativeChatStream(...a) } }));

import { streamNativeAgentChat } from "../native-client";

afterEach(() => {
  handlers.clear();
  nativeChatStream.mockReset();
});

const MSGS: Message[] = [{ conversation_id: 1, role: "user", content: "list files" }];

function emit(suffix: string, payload: unknown) {
  for (const [event, cb] of handlers) {
    if (event.startsWith(suffix)) cb({ payload });
  }
}

describe("streamNativeAgentChat", () => {
  it("aggregates text deltas and parses tool calls into ToolCall shape", async () => {
    nativeChatStream.mockImplementation(async () => {
      emit("native-chunk:", "Hello ");
      emit("native-chunk:", "world");
      emit("native-toolcalls:", [
        { id: "call-1", name: "list_dir", arguments: '{"path":"/tmp"}' },
      ]);
      return "Hello world";
    });

    const chunks: string[] = [];
    const result = await streamNativeAgentChat(
      MSGS,
      [{ type: "function", function: { name: "list_dir" } }],
      new AbortController().signal,
      (d) => chunks.push(d),
    );

    expect(chunks).toEqual(["Hello ", "world"]);
    expect(result.content).toBe("Hello world");
    expect(result.tool_calls).toEqual([
      { id: "call-1", type: "function", function: { name: "list_dir", arguments: { path: "/tmp" } } },
    ]);
  });

  it("keeps non-JSON tool arguments as a raw string", async () => {
    nativeChatStream.mockImplementation(async () => {
      emit("native-toolcalls:", [{ id: "c2", name: "noop", arguments: "not-json" }]);
      return "";
    });

    const result = await streamNativeAgentChat(
      MSGS,
      [],
      new AbortController().signal,
      () => {},
    );

    expect(result.tool_calls[0].function.arguments).toBe("not-json");
  });

  it("returns an empty tool_calls list when the model emits none", async () => {
    nativeChatStream.mockImplementation(async () => {
      emit("native-chunk:", "plain reply");
      return "plain reply";
    });

    const result = await streamNativeAgentChat(
      MSGS,
      [],
      new AbortController().signal,
      () => {},
    );

    expect(result.content).toBe("plain reply");
    expect(result.tool_calls).toEqual([]);
  });

  it("forwards assistant tool_calls and tool results as OpenAI-style messages", async () => {
    nativeChatStream.mockResolvedValue("done");

    const convo: Message[] = [
      { conversation_id: 1, role: "user", content: "go" },
      {
        conversation_id: 1,
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "list_dir", arguments: { path: "/" } } },
        ],
      },
      { conversation_id: 1, role: "tool", content: "a.txt", tool_call_id: "c1", tool_name: "list_dir" },
    ];

    await streamNativeAgentChat(convo, [], new AbortController().signal, () => {});

    const sent = nativeChatStream.mock.calls[0][0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(sent.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "list_dir", arguments: '{"path":"/"}' } },
      ],
    });
    expect(sent.messages[2]).toMatchObject({
      role: "tool",
      content: "a.txt",
      tool_call_id: "c1",
      name: "list_dir",
    });
  });
});
