/* ── Backend-aware agent chat ──────────────────────────────────────────────
 *
 * The agent runner needs one tool-calling chat primitive that yields the same
 * `StreamChatResult` shape (content + merged tool_calls + token counts)
 * regardless of which LLM backend is active.
 *
 *  - ollama: NDJSON /api/chat (existing path, unchanged).
 *  - mlx:    OpenAI-compatible /v1/chat/completions with `tools`.
 *  - native: mistralrs in-process — `tools` are passed through the Rust
 *            request and tool calls come back via the `native-toolcalls`
 *            event (see `native-client.ts`).
 */

import type { Message } from "../../types";
import type { AgentBackend, AgentRunOptions } from "./types";
import { resolveAgentChatConfig } from "./types";
export type { ChatParams } from "./types";
import {
  OLLAMA_BASE,
  RETRY_BACKOFF_MS,
  RETRY_MAX,
  streamOllamaChat,
  toOllamaMessages,
} from "./ollama-client";
import type { StreamChatResult } from "./stream-types";
import { streamMlxAgentChat } from "../mlx-client";
import { streamNativeAgentChat } from "../native-client";

/** Human-readable reason agent mode can't run on a given backend, or null. */
export function agentBackendUnsupportedReason(
  _backend: AgentBackend,
): string | null {
  return null;
}

/**
 * One streaming, tool-calling chat turn against the active backend, with
 * 5xx/transient retry. `metricsOnRetry` is bumped each time a retry fires so
 * the runner can surface it. Errors after the final attempt propagate.
 */
export async function streamAgentChat(
  opts: AgentRunOptions,
  msgs: Message[],
  tools: readonly unknown[],
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
  onRetry: () => void,
): Promise<StreamChatResult> {
  const backend: AgentBackend = opts.backend ?? "ollama";
  const params = opts.params ?? null;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      if (backend === "mlx") {
        if (!opts.serverStatus) {
          throw new Error("MLX backend selected but no server status was provided");
        }
        return await streamMlxAgentChat(
          opts.serverStatus,
          msgs,
          tools,
          signal,
          onContentChunk,
          params,
        );
      }
      if (backend === "native") {
        return await streamNativeAgentChat(msgs, tools, signal, onContentChunk, params);
      }
      // Default: Ollama. Base AgentChatConfig resolved once; per-conversation
      // params override individual fields (resolveAgentChatConfig handles the
      // null-fallthrough). Applied uniformly with the mlx/native paths.
      const cfg = resolveAgentChatConfig(params);
      const ollamaOptions: Record<string, unknown> = {
        temperature: cfg.temperature,
        top_p: cfg.top_p,
        num_predict: cfg.max_tokens,
        num_ctx: cfg.context_size,
      };
      return await streamOllamaChat(
        `${OLLAMA_BASE}/api/chat`,
        {
          model: opts.model,
          options: ollamaOptions,
          messages: toOllamaMessages(msgs),
          tools,
        },
        signal,
        onContentChunk,
      );
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      // Retry only known-transient failures: an explicit 5xx response, or a
      // genuine network/connection error. Everything else — 4xx, aborts,
      // parse errors, and generic thrown errors — propagates immediately so a
      // non-idempotent turn is never silently re-streamed.
      const is5xx = /\b5\d\d:/.test(msg);
      const isAbort =
        (e instanceof Error && e.name === "AbortError") || /\baborted\b/i.test(msg);
      // A `fetch` connection failure surfaces as a TypeError; the request
      // timeout helper throws "... timed out". Both are transient transport
      // faults, not response errors.
      const isNetwork =
        !isAbort &&
        ((e instanceof TypeError && !/\b\d{3}:/.test(msg)) || /timed out/i.test(msg));
      const isRetriable = is5xx || isNetwork;
      if (isRetriable && attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("agent chat failed");
}
