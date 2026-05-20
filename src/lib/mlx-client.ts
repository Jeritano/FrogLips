import type { Message, ServerStatus } from "../types";

export interface ChatChunk {
  delta: string;
  done: boolean;
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
    signal: opts.signal,
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
