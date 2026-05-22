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
        );
      }
      if (backend === "native") {
        return await streamNativeAgentChat(msgs, tools, signal, onContentChunk);
      }
      // Default: Ollama.
      return await streamOllamaChat(
        `${OLLAMA_BASE}/api/chat`,
        {
          model: opts.model,
          options: { temperature: 0.4 },
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
      // Retry transient failures only: explicit 5xx and bare network errors.
      // A definite 4xx (bad request) or auth failure is not retried.
      const is5xx = /\b5\d\d:/.test(msg);
      const isHttpStatus = /\b\d{3}:/.test(msg);
      const isRetriable = is5xx || !isHttpStatus;
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
