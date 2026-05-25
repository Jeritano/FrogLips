import type { Message, ServerStatus } from "../types";
import { api } from "./tauri-api";
import type { ChatChunk } from "./mlx-client";

/**
 * Novita.ai chat streaming client.
 *
 * Mirrors the signature of `streamChat` in `mlx-client.ts` so `ChatWindow`
 * can dispatch by backend type. Differences:
 *   - URL is the hardcoded HTTPS endpoint, not derived from `status.host:port`
 *   - Bearer auth via the keychain-stored API key, fetched per-request and
 *     scoped to this generator's closure (no module-level cache)
 *   - Same OpenAI-compatible SSE shape, so the parser is the same as MLX
 */

const NOVITA_CHAT_URL = "https://api.novita.ai/v3/openai/chat/completions";
const MAX_BUF = 1 << 20; // 1 MiB safety bound on stream buffer

export async function* streamChat(
  status: ServerStatus,
  messages: Message[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ChatChunk> {
  if (!status.model) {
    throw new Error("no model selected");
  }

  // Just-in-time key fetch. We do NOT store this in any module-level variable
  // or React state — it lives only on this generator's call stack for the
  // duration of the fetch, then the JS engine discards it.
  const key = await api.novitaGetKey();
  if (!key) {
    throw new Error("Novita API key not configured. Open Settings → Novita to add one.");
  }

  const body = {
    model: status.model,
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetch(NOVITA_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    // Strip the key from any echo in the response body (defensive — Novita
    // shouldn't echo it, but we never want it shown in an error toast).
    const sanitized = txt.split(key).join("[redacted]");
    throw new Error(`novita ${res.status}: ${sanitized}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

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
        yield { delta: "", done: true };
        return;
      }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content ?? "";
        if (delta) yield { delta, done: false };
      } catch {
        // skip keepalives / malformed lines
      }
    }
  }
  yield { delta: "", done: true };
}
