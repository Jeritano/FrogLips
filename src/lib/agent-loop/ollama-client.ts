import type { Message, ToolCall } from "../../types";
import { withTimeout } from "../signal-utils";
import { readLines } from "../stream-lines";
import { finalizeToolCalls, mergeToolCallChunk } from "./tool-call-merge";
import type { PartialToolCall, StreamChatResult } from "./stream-types";

export const OLLAMA_BASE = "http://127.0.0.1:11434";
export const RETRY_MAX = 2;
export const RETRY_BACKOFF_MS = 500;

const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

export type { PartialToolCall, StreamChatResult } from "./stream-types";
export { finalizeToolCalls, mergeToolCallChunk } from "./tool-call-merge";

/* ── Message serialisation ── */

export function toOllamaMessages(msgs: Message[]) {
  return msgs.map((m) => {
    if (m.role === "tool") {
      return { role: "tool" as const, content: m.content };
    }
    if (m.tool_calls?.length) {
      // Ollama's Go server rejects `function.arguments` as an object — its
      // struct expects a JSON-encoded string ("json: cannot unmarshal object
      // into Go struct field .messages.tool_calls.function.arguments of type
      // string"). The OpenAI spec also defines arguments as a string. Some
      // models (qwen3-coder via huihui-abliterated, etc.) round-trip the field
      // as an object; normalize before send.
      // Cloud-routing models (kimi-k2.6:cloud, deepseek-v4-pro:cloud,
       // …) re-parse `arguments` strictly. If the previous-turn stream
       // produced a partial / truncated JSON (model paused mid-thought
       // before finishing the close brace), passing the raw string back
       // returns 400 "Value looks like object, but can't find closing
       // '}' symbol". Validate + repair: if the string isn't parseable
       // JSON, replace with "{}" so the round-trip works. We log the
       // repair via diagnostics so the loop can recover gracefully.
      const normalized = m.tool_calls
        // Drop any tool_call that lacks a function name — cloud routing
        // refuses the whole request on a single empty-name entry.
        .filter((tc) => tc.function && typeof tc.function.name === "string" && tc.function.name.length > 0)
        .map((tc) => {
          const raw =
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {});
          let safe = raw;
          if (raw && raw !== "{}") {
            try {
              JSON.parse(raw);
            } catch {
              safe = "{}";
            }
          }
          return {
            ...tc,
            // Ensure id is present — cloud routers require it.
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            function: { ...tc.function, arguments: safe },
          };
        });
      // If every tool_call was filtered out as invalid, fall through to
      // the plain-assistant branch — sending `tool_calls: []` would also
      // trigger the cloud schema reject we saw above.
      if (normalized.length === 0) {
        return { role: "assistant" as const, content: m.content ?? "" };
      }
      return { role: "assistant" as const, content: m.content ?? "", tool_calls: normalized };
    }
    // Vision: Ollama /api/chat accepts `images: [base64...]` alongside text.
    // The base64 must be the raw payload — no `data:` prefix.
    if (m.role === "user" && m.images && m.images.length > 0) {
      return {
        role: "user" as const,
        content: m.content,
        images: m.images.map((img) => img.base64),
      };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
}

/* ── Streaming chat ── */

/**
 * Stream an Ollama /api/chat call. Parses NDJSON lines; fires `onContentChunk`
 * for each non-empty content delta, accumulates tool_calls (merging chunks by
 * index), and returns the final aggregated result.
 *
 * Buffer handling: chunks may split mid-line — `readLines` accumulates the
 * leftover tail across reads and only emits complete `\n`-terminated lines.
 */
export async function streamOllamaChat(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
): Promise<StreamChatResult> {
  const to = withTimeout(signal, OLLAMA_REQUEST_TIMEOUT_MS, "Ollama request timed out");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(body as object), stream: true }),
    signal: to.signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  }
  if (!res.body) {
    throw new Error("Ollama response has no body");
  }

  let content = "";
  const toolAcc: PartialToolCall[] = [];
  let promptTok: number | undefined;
  let evalTok: number | undefined;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // skip malformed lines
    }
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg) {
      const c = msg.content;
      if (typeof c === "string" && c.length > 0) {
        content += c;
        onContentChunk(c);
      }
      const tcs = msg.tool_calls as Array<Partial<ToolCall> & { index?: number }> | undefined;
      if (Array.isArray(tcs)) {
        tcs.forEach((tc, i) => {
          const idx = typeof tc.index === "number" ? tc.index : i;
          mergeToolCallChunk(toolAcc, idx, tc);
        });
      }
    }
    if (typeof obj.prompt_eval_count === "number") promptTok = obj.prompt_eval_count;
    if (typeof obj.eval_count === "number") evalTok = obj.eval_count;
  };

  try {
    await readLines(res.body.getReader(), processLine);
  } finally {
    to.clear();
  }

  return {
    content,
    tool_calls: finalizeToolCalls(toolAcc),
    prompt_eval_count: promptTok,
    eval_count: evalTok,
  };
}
