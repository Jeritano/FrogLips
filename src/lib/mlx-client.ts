import type { Message, ServerStatus, ToolCall } from "../types";
import { finalizeToolCalls, mergeToolCallChunk } from "./agent-loop/tool-call-merge";
import type { PartialToolCall, StreamChatResult } from "./agent-loop/stream-types";
import type { ChatParams } from "./agent-loop/types";
import { resolveAgentChatConfig } from "./agent-loop/types";
import { withInactivityTimeout } from "./signal-utils";
import { readLines } from "./stream-lines";

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
    // can match the following `tool` messages to their requests. Normalize
    // `arguments` to a string: the OpenAI spec (which MLX's OpenAI-compatible
    // server enforces) defines it as string, and some models round-trip the
    // field as a parsed object which the server then rejects.
    if (m.tool_calls?.length) {
      const normalized = m.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
      return { role: "assistant", content: m.content ?? "", tool_calls: normalized };
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
// Mid-stream inactivity cap. Once headers arrive, abort if NO token arrives for
// this long — a stalled MLX server (no server-side cancel exists) would
// otherwise wedge the agent loop until the user hits Stop. Generous enough that
// a slow heavy model between tokens never trips it.
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export async function* streamChat(
  status: ServerStatus,
  messages: Message[],
  opts: { temperature?: number; topP?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ChatChunk> {
  const url = `http://${status.host}:${status.port}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: status.model,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    messages: toOpenAiMessages(messages),
  };
  if (opts.topP != null) body.top_p = opts.topP;
  // Ollama-only: keep the model resident between turns so the 2nd+ message
  // doesn't pay a multi-second cold reload. `keep_alive` is an Ollama extension
  // its OpenAI-compat endpoint honors; gated to ollama so MLX's stricter server
  // never sees an unknown field. Request-level value — doesn't override a
  // daemon the user tuned more aggressively.
  if (status.backend === "ollama") body.keep_alive = "5m";

  // Inactivity watchdog: a generous first-byte/cold-load window, then a
  // shorter per-token idle cap (re-armed on every chunk). Aborts a stalled
  // server instead of streaming forever.
  const to = withInactivityTimeout(opts.signal, STREAM_IDLE_TIMEOUT_MS, "MLX stream stalled");
  to.kick(STREAM_CONNECT_TIMEOUT_MS);
  try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: to.signal,
  });
  // Headers arrived — switch from the cold-load window to the idle cadence.
  to.kick();

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`server ${res.status}: ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const MAX_BUF = 1 << 20; // 1 MB — guard against malformed server output
  // Reasoning-model fallback: capture `delta.reasoning` / `reasoning_content`
  // and, if the turn produces NO `content` (e.g. gemma4 and other "thinking"
  // models that stream only reasoning), surface the reasoning so the reply
  // isn't dropped as an empty response.
  let anyContent = false;
  let reasoningAcc = "";
  const REASONING_CAP = 1 << 20;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    to.kick(); // reset the idle timer on each received chunk
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
        if (!anyContent && reasoningAcc) yield { delta: reasoningAcc, done: false };
        yield { delta: "", done: true };
        return;
      }
      try {
        const obj = JSON.parse(payload);
        const d = obj?.choices?.[0]?.delta ?? {};
        const content: string = d?.content ?? "";
        if (content) {
          anyContent = true;
          yield { delta: content, done: false };
        } else if (!anyContent) {
          const r: string = d?.reasoning ?? d?.reasoning_content ?? "";
          if (r && reasoningAcc.length < REASONING_CAP) reasoningAcc += r;
        }
      } catch {
        // skip keepalives
      }
    }
  }
  if (!anyContent && reasoningAcc) yield { delta: reasoningAcc, done: false };
  yield { delta: "", done: true };
  } finally {
    to.clear();
  }
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
  params?: ChatParams | null,
): Promise<StreamChatResult> {
  const url = `http://${status.host}:${status.port}/v1/chat/completions`;
  // Shared AgentChatConfig base; per-conversation params override fields.
  const cfg = resolveAgentChatConfig(params);
  const body: Record<string, unknown> = {
    model: status.model,
    stream: true,
    temperature: cfg.temperature,
    top_p: cfg.top_p,
    max_tokens: cfg.max_tokens,
    messages: toOpenAiMessages(messages),
  };
  if (tools.length > 0) body.tools = tools;

  // Inactivity watchdog (see streamChat): generous cold-load window, then a
  // per-token idle cap so a stalled MLX server can't wedge the agent loop.
  const to = withInactivityTimeout(signal, STREAM_IDLE_TIMEOUT_MS, "MLX stream stalled");
  to.kick(STREAM_CONNECT_TIMEOUT_MS);
  try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: to.signal,
  });
  to.kick(); // headers arrived → idle cadence

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MLX ${res.status}: ${txt}`);
  }

  // TODO: best-effort server-side cancel on abort. The native runtime mirrors
  // this pattern in `native-client.ts` (listens for `signal.abort` and calls
  // `api.nativeCancelChat(opId)` so the backend stops generating). MLX's
  // OpenAI-compatible `mlx_lm.server` does NOT currently expose a parallel
  // cancel endpoint — no `mlx_cancel` / `mlxCancelChat` invocation is wired
  // in `tauri-api.ts`. Aborting the fetch here closes the HTTP connection
  // but the MLX process keeps generating until the request completes
  // upstream. If a cancel command is added later (mirroring native), wire it
  // here via `signal.addEventListener("abort", …)` the same way.

  let content = "";
  const toolAcc: PartialToolCall[] = [];
  let promptTok: number | undefined;
  let evalTok: number | undefined;
  let sawDone = false;

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

  await readLines(res.body.getReader(), (rawLine) => {
    to.kick(); // reset the idle timer on each received line
    if (sawDone) return;
    const line = rawLine.trim();
    if (!line || !line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    processPayload(payload);
  });

  return {
    content,
    tool_calls: finalizeToolCalls(toolAcc),
    prompt_eval_count: promptTok,
    eval_count: evalTok,
  };
  } finally {
    to.clear();
  }
}
