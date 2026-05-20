import type { Message } from "../../types";

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

export async function callOllamaWithRetry(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onRetry: () => void,
): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combinedSignal(signal, OLLAMA_REQUEST_TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;
      // network / fetch errors retry up to RETRY_MAX
      if (attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("Ollama call failed");
}
