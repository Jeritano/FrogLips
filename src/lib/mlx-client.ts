import type { Message, ServerStatus } from "../types";

export interface ChatChunk {
  delta: string;
  done: boolean;
}

// Time-to-first-byte cap. Aborts the request if the server hasn't replied
// with response headers within this window — prevents the UI from wedging
// on a dead Ollama / MLX daemon. Streaming itself isn't bounded; tokens
// arriving keeps the connection alive.
const STREAM_CONNECT_TIMEOUT_MS = 30_000;

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
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
  return ctrl.signal;
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
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(opts.signal, STREAM_CONNECT_TIMEOUT_MS),
  });

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
