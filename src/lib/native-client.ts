import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./tauri-api";
import type { Message } from "../types";

export interface NativeChunk {
  delta: string;
  done: boolean;
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
      if (opts.signal?.aborted) {
        // Best-effort abort: stop draining. Native loop keeps running upstream.
        break;
      }
      if (queue.length === 0 && !done) {
        await Promise.race([wait(), reqPromise.catch(() => {})]);
        continue;
      }
      const delta = queue.shift();
      if (delta != null) yield { delta, done: false };
    }
    yield { delta: "", done: true };
  } finally {
    offChunk();
    offDone();
    // Surface server-side error if any.
    try { await reqPromise; } catch (e) {
      throw e;
    }
  }
}
