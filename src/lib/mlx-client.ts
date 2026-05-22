import type { Message, ServerStatus, ToolCall } from "../types";
import {
  finalizeToolCalls,
  mergeToolCallChunk,
  type PartialToolCall,
  type StreamChatResult,
} from "./agent-loop/ollama-client";

export interface ChatChunk {
  delta: string;
  done: boolean;
}

/** Serialise app messages into the OpenAI chat-completions wire format. */
function toOpenAiMessages(messages: Message[]) {
  return messages.map((m) => {
    // Vision: OpenAI-compat endpoints accept the multi-content form. Use it
    // only when the user message actually carries images.
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mime};base64,${img.base64}` },
        });
      }
      return { role: m.role, content: parts };
    }
    // Assistant turn that issued tool calls — forward them so the server
    // can match the following `tool` messages to their requests.
    if (m.tool_calls?.length) {
      return { role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
    }
    return { role: m.role, content: m.content };
  });
}

// Time-to-first-byte cap. Aborts the request if the server hasn't replied
// with response headers within this window — prevents the UI from wedging
// on a dead Ollama / MLX daemon. Streaming itself isn't bounded; tokens
// arriving keeps the connection alive. Bumped from 30s → 5min because
// huge models (60+ GB) take minutes to cold-load before MLX sends headers.
const STREAM_CONNECT_TIMEOUT_MS = 300_000;

function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener("abort", () => ctrl.abort(parent.reason), { once: true });
  }
  const t = setTimeout(
    () => ctrl.abort(new DOMException("stream connect timed out", "TimeoutError")),
    timeoutMs,
  );
  ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

export async function* streamChat(
  status: ServerStatus,
  messages: Message[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ChatChunk> {
  const url = `http://${status.host}:${status.port}/v1/chat/completions`;
  const body = {
    model: status.model,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    messages: toOpenAiMessages(messages),
  };

  const to = withTimeout(opts.signal, STREAM_CONNECT_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: to.signal,
  });
  // Clear the connect-timeout the moment headers arrive. Streaming itself
  // is unbounded; tokens may take seconds between chunks on heavy models.
  to.clear();

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`server ${res.status}: ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const MAX_BUF = 1 << 20; // 1 MB — guard against malformed server output

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.length > MAX_BUF) {
      // Truncate only at a newline boundary so we don't slice "data:" prefix mid-line
      const lastNl = buf.lastIndexOf("\n", buf.length - MAX_BUF);
      buf = lastNl >= 0 ? buf.slice(lastNl + 1) : "";
    }

    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield { delta: "", done: true };
        return;
      }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content ?? "";
        if (delta) yield { delta, done: false };
      } catch {
        // skip keepalives
      }
    }
  }
  yield { delta: "", done: true };
}

/**
 * Agent-mode chat against an MLX `mlx_lm.server` (OpenAI-compatible) endpoint.
 *
 * Unlike `streamChat`, this accepts a `tools` parameter and parses streaming
 * `tool_calls` deltas, returning the same `StreamChatResult` shape the agent
 * runner consumes from Ollama. tool_call deltas in the OpenAI streaming format
 * arrive piecewise (name first, then argument fragments) keyed by `index` —
 * we reuse the Ollama merge helper to accumulate them.
 */
export async function streamMlxAgentChat(
  status: ServerStatus,
  messages: Message[],
  tools: readonly unknown[],
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
): Promise<StreamChatResult> {
  const url = `http://${status.host}:${status.port}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: status.model,
    stream: true,
    temperature: 0.4,
    max_tokens: 2048,
    messages: toOpenAiMessages(messages),
  };
  if (tools.length > 0) body.tools = tools;

  const to = withTimeout(signal, STREAM_CONNECT_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: to.signal,
  });
  to.clear();

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MLX ${res.status}: ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const toolAcc: PartialToolCall[] = [];
  let promptTok: number | undefined;
  let evalTok: number | undefined;
  const MAX_BUF = 1 << 20;

  const processPayload = (payload: string) => {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // skip keepalives / malformed lines
    }
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (delta) {
      const c = delta.content;
      if (typeof c === "string" && c.length > 0) {
        content += c;
        onContentChunk(c);
      }
      const tcs = delta.tool_calls as Array<Partial<ToolCall> & { index?: number }> | undefined;
      if (Array.isArray(tcs)) {
        tcs.forEach((tc, i) => {
          const idx = typeof tc.index === "number" ? tc.index : i;
          mergeToolCallChunk(toolAcc, idx, tc);
        });
      }
    }
    const usage = obj.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") promptTok = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") evalTok = usage.completion_tokens;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_BUF) {
        const lastNl = buf.lastIndexOf("\n", buf.length - MAX_BUF);
        buf = lastNl >= 0 ? buf.slice(lastNl + 1) : "";
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return {
            content,
            tool_calls: finalizeToolCalls(toolAcc),
            prompt_eval_count: promptTok,
            eval_count: evalTok,
          };
        }
        processPayload(payload);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {/* noop */}
  }

  return {
    content,
    tool_calls: finalizeToolCalls(toolAcc),
    prompt_eval_count: promptTok,
    eval_count: evalTok,
  };
}
