import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./tauri-api";
import type { Message, ToolCall } from "../types";
import type { StreamChatResult } from "./agent-loop/stream-types";
import type { ChatParams } from "./agent-loop/types";
import { resolveAgentChatConfig } from "./agent-loop/types";

export interface NativeChunk {
  delta: string;
  done: boolean;
}

/** Raw tool call shape emitted by the Rust `native-toolcalls` event. */
interface NativeToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Stream a chat completion through the native mistralrs runtime.
 * Yields `{delta, done}` chunks. Aborts when `signal` fires (best-effort —
 * the native runtime keeps generating in the background until it hits a
 * natural stop). Caller should ignore further deltas once aborted.
 */
export async function* streamNativeChat(
  messages: Message[],
  opts: { temperature?: number; top_p?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<NativeChunk> {
  const opId = `native-${crypto.randomUUID()}`;
  const queue: string[] = [];
  let done = false;
  let resolver: (() => void) | null = null;

  const wake = () => { if (resolver) { resolver(); resolver = null; } };
  const wait = () => new Promise<void>((r) => { resolver = r; });

  const offChunk: UnlistenFn = await listen<string>(`native-chunk:${opId}`, (e) => {
    queue.push(e.payload);
    wake();
  });
  const offDone: UnlistenFn = await listen<string>(`native-done:${opId}`, () => {
    done = true;
    wake();
  });

  // Abort → tell the native runtime to stop decoding (otherwise it runs to
  // max_tokens after Stop), and wake the loop so it observes signal.aborted
  // immediately. CORR-HIGH (2026-05-30): this wiring was present on the agent
  // path but missing here, so plain native chat Stop was a no-op.
  const onAbort = () => {
    void api.nativeCancelChat(opId).catch(() => {});
    wake();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Kick off the request without awaiting — it resolves only when generation
  // is fully complete. We consume chunks via events meanwhile.
  const reqPromise = api.nativeChatStream({
    op_id: opId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature,
    top_p: opts.top_p,
    max_tokens: opts.maxTokens,
  });

  try {
    while (!done || queue.length > 0) {
      if (opts.signal?.aborted) break; // cancel already signalled to the backend
      if (queue.length === 0 && !done) {
        await Promise.race([wait(), reqPromise.catch(() => {})]);
        continue;
      }
      const delta = queue.shift();
      if (delta != null) yield { delta, done: false };
    }
    yield { delta: "", done: true };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    offChunk();
    offDone();
    // Surface server-side error if any.
    try { await reqPromise; } catch (e) {
      throw e;
    }
  }
}

/**
 * Serialize agent messages into the OpenAI-style shape the native command
 * expects. Assistant `tool_calls` and `tool` results are forwarded so the
 * model's chat template can round-trip a multi-step agent loop. mistralrs
 * wants tool-call `arguments` as a JSON string.
 */
function toNativeMessages(messages: Message[]) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {}),
          },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.tool_name,
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Convert a raw native tool call into the agent loop's `ToolCall` shape. */
function toToolCall(tc: NativeToolCall): ToolCall {
  let args: Record<string, unknown> | string = tc.arguments;
  try {
    const parsed = JSON.parse(tc.arguments);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // Leave as the raw string — dispatch.parseArgs tolerates both forms.
  }
  return { id: tc.id, type: "function", function: { name: tc.name, arguments: args } };
}

/**
 * One tool-calling chat turn against the native mistralrs runtime, yielding
 * the same `StreamChatResult` shape the Ollama/MLX agent clients produce.
 * The native runtime returns whole tool calls at once (no chunk merging).
 */
export async function streamNativeAgentChat(
  messages: Message[],
  tools: readonly unknown[],
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
  params?: ChatParams | null,
): Promise<StreamChatResult> {
  // Fast path: if the caller already aborted before we even started, bail
  // out without spinning up event listeners or hitting Rust IPC.
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException("aborted", "AbortError");
  }

  const opId = `native-${crypto.randomUUID()}`;
  let content = "";
  let toolCalls: ToolCall[] = [];

  const offChunk: UnlistenFn = await listen<string>(`native-chunk:${opId}`, (e) => {
    if (signal.aborted) return;
    content += e.payload;
    onContentChunk(e.payload);
  });
  const offTools: UnlistenFn = await listen<NativeToolCall[]>(
    `native-toolcalls:${opId}`,
    (e) => { toolCalls = e.payload.map(toToolCall); },
  );

  // Wire the caller's abort signal to a best-effort native cancel. The native
  // runtime may not expose a cancel command on every build (the API shape is
  // backend-dependent), so we look it up dynamically and silently drop the
  // call if it isn't there — the abort still stops further chunk forwarding
  // via the `signal.aborted` guard in the listener above.
  const onAbort = () => {
    const cancelFn = (api as unknown as Record<string, unknown>)["nativeCancelChat"];
    if (typeof cancelFn === "function") {
      try {
        void (cancelFn as (id: string) => Promise<unknown>)(opId);
      } catch {
        /* best-effort */
      }
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    // Shared AgentChatConfig base; per-conversation params override fields.
    // Without this the agent path passed no token cap to the native runtime.
    const cfg = resolveAgentChatConfig(params);
    await api.nativeChatStream({
      op_id: opId,
      messages: toNativeMessages(messages),
      tools: tools as Record<string, unknown>[],
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      max_tokens: cfg.max_tokens,
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    offChunk();
    offTools();
  }

  return { content, tool_calls: toolCalls };
}
