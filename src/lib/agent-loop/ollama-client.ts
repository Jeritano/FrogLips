import type { Message, ToolCall } from "../../types";

export const OLLAMA_BASE = "http://127.0.0.1:11434";
export const RETRY_MAX = 2;
export const RETRY_BACKOFF_MS = 500;

const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

/* ── Message serialisation ── */

export function toOllamaMessages(msgs: Message[]) {
  return msgs.map((m) => {
    if (m.role === "tool") {
      return { role: "tool" as const, content: m.content };
    }
    if (m.tool_calls?.length) {
      return { role: "assistant" as const, content: m.content ?? "", tool_calls: m.tool_calls };
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

function combinedSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent.reason);
  if (parent.aborted) ctrl.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(new DOMException("Ollama request timed out", "TimeoutError")), timeoutMs);
  ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return ctrl.signal;
}

/* ── Streaming chat ── */

export interface StreamChatResult {
  content: string;
  tool_calls: ToolCall[];
  prompt_eval_count?: number;
  eval_count?: number;
}

interface PartialToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: unknown;
    _argStr?: string;
  };
}

/**
 * Merge an incoming tool_call chunk into the accumulator slot. Ollama emits
 * tool_calls in pieces — first a slot with `function.name`, then later slots
 * with additional `function.arguments` text — keyed by array index.
 * Some servers emit `arguments` as a string fragment (concat), others as a
 * full object (replace). We handle both.
 */
function mergeToolCallChunk(
  acc: PartialToolCall[],
  index: number,
  chunk: Partial<ToolCall> & { function?: Partial<ToolCall["function"]> },
): void {
  let slot = acc[index];
  if (!slot) {
    slot = { function: { name: "", arguments: undefined } };
    acc[index] = slot;
  }
  if (chunk.id !== undefined) slot.id = chunk.id;
  if (chunk.type !== undefined) slot.type = chunk.type;
  if (chunk.function) {
    if (chunk.function.name !== undefined && chunk.function.name !== "") {
      slot.function.name = chunk.function.name;
    }
    if (chunk.function.arguments !== undefined) {
      const a = chunk.function.arguments;
      if (typeof a === "string") {
        slot.function._argStr = (slot.function._argStr ?? "") + a;
        // Attempt to keep arguments parsed as we go; final pass below cleans up.
        slot.function.arguments = slot.function._argStr;
      } else if (a && typeof a === "object") {
        // Object form — replace (Ollama tends to send the whole object in one chunk).
        slot.function.arguments = a as Record<string, unknown>;
        slot.function._argStr = undefined;
      }
    }
  }
}

function finalizeToolCalls(acc: PartialToolCall[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const slot of acc) {
    if (!slot) continue;
    let args: Record<string, unknown> | string = "";
    if (slot.function._argStr !== undefined) {
      // String form — try to JSON.parse, fall back to raw string (dispatch.parseArgs handles both).
      const s = slot.function._argStr;
      try {
        const parsed = JSON.parse(s);
        args = parsed && typeof parsed === "object" ? parsed : s;
      } catch {
        args = s;
      }
    } else if (slot.function.arguments && typeof slot.function.arguments === "object") {
      args = slot.function.arguments as Record<string, unknown>;
    }
    out.push({
      id: slot.id ?? "",
      type: "function",
      function: {
        name: slot.function.name,
        arguments: args,
      },
    });
  }
  return out;
}

/**
 * Stream an Ollama /api/chat call. Parses NDJSON lines; fires `onContentChunk`
 * for each non-empty content delta, accumulates tool_calls (merging chunks by
 * index), and returns the final aggregated result.
 *
 * Buffer handling: chunks may split mid-line, so we accumulate the leftover
 * tail across reads and only parse complete `\n`-terminated lines.
 */
export async function streamOllamaChat(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _onToolCalls?: (calls: ToolCall[]) => void,
): Promise<StreamChatResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(body as object), stream: true }),
    signal: combinedSignal(signal, OLLAMA_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  }
  if (!res.body) {
    throw new Error("Ollama response has no body");
  }

  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buf = "";
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
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        processLine(line);
      }
    }
    if (buf.length > 0) processLine(buf);
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

/**
 * Backwards-compat wrapper: streams under the hood, drains to a single
 * response object shaped like the prior non-streaming JSON. Retries on
 * 5xx / network errors up to RETRY_MAX with linear backoff.
 */
export async function callOllamaWithRetry(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onRetry: () => void,
  onContentChunk?: (delta: string) => void,
): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      const result = await streamOllamaChat(
        url,
        body,
        signal,
        (delta) => onContentChunk?.(delta),
      );
      return {
        message: {
          content: result.content,
          tool_calls: result.tool_calls,
        },
        prompt_eval_count: result.prompt_eval_count,
        eval_count: result.eval_count,
      };
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;
      // Retry on 5xx (parsed from message) and generic network errors.
      const msg = e instanceof Error ? e.message : String(e);
      const isRetriable = /Ollama 5\d\d:/.test(msg) || !/Ollama \d{3}:/.test(msg);
      if (isRetriable && attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("Ollama call failed");
}
