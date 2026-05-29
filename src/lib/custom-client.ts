import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./tauri-api";
import type { Message } from "../types";

export interface CustomChunk {
  delta: string;
  done: boolean;
}

/**
 * Stream a chat completion from a custom OpenAI-compatible cloud backend
 * (OpenRouter / Groq / etc). Mirrors `streamNativeChat`'s event-driven
 * shape: the Rust `custom_chat_stream` command emits
 * `custom-chunk:{opId}` deltas + a terminal `custom-done:{opId}` /
 * `custom-error:{opId}`; this generator reassembles them into
 * `{delta, done}` chunks.
 *
 * `backendId` is the `CustomBackend.id` from settings — the Rust side
 * resolves base_url + model + the Keychain-stored API key from it, so the
 * key never crosses into the webview.
 *
 * Abort is best-effort: on `signal`, draining stops. The Rust request may
 * keep running upstream until its natural stop; the caller ignores further
 * deltas once aborted.
 */
export async function* streamCustomChat(
  backendId: string,
  messages: Message[],
  opts: { temperature?: number; top_p?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<CustomChunk> {
  const opId = `custom-${crypto.randomUUID()}`;
  const queue: string[] = [];
  let done = false;
  let errMsg: string | null = null;
  let resolver: (() => void) | null = null;

  const wake = () => { if (resolver) { resolver(); resolver = null; } };
  const wait = () => new Promise<void>((r) => { resolver = r; });

  const offChunk: UnlistenFn = await listen<{ delta: string }>(
    `custom-chunk:${opId}`,
    (e) => {
      if (e.payload?.delta) queue.push(e.payload.delta);
      wake();
    },
  );
  const offDone: UnlistenFn = await listen<unknown>(`custom-done:${opId}`, () => {
    done = true;
    wake();
  });
  const offErr: UnlistenFn = await listen<string>(`custom-error:${opId}`, (e) => {
    errMsg = typeof e.payload === "string" ? e.payload : "custom backend error";
    done = true;
    wake();
  });

  // Kick off without awaiting — resolves only when generation completes.
  const reqPromise = api.customChatStream({
    op_id: opId,
    backend_id: backendId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature,
    top_p: opts.top_p,
    max_tokens: opts.maxTokens,
  });

  try {
    while (!done || queue.length > 0) {
      if (opts.signal?.aborted) break;
      if (queue.length === 0 && !done) {
        await Promise.race([wait(), reqPromise.catch(() => {})]);
        continue;
      }
      const delta = queue.shift();
      if (delta != null) yield { delta, done: false };
    }
    // Surface a streamed error AFTER draining buffered deltas so partial
    // output isn't lost.
    if (errMsg) throw new Error(errMsg);
    yield { delta: "", done: true };
  } finally {
    offChunk();
    offDone();
    offErr();
    // Surface a command-level rejection (HTTP error, bad backend id) that
    // didn't already arrive via the custom-error event.
    try { await reqPromise; } catch (e) {
      if (!errMsg) throw e;
    }
  }
}
