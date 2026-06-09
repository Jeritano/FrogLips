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
      // Cloud-routing models (kimi-k2.6:cloud, deepseek-v4-pro:cloud, …) run
      // on the provider's own infra with server-side defaults. The cloud
      // passthrough re-validates each request strictly and has been observed
      // to reject Ollama's `options` payload outright with the cryptic
      // "Value looks like object, but can't find closing '}' symbol" 400 —
      // even when every value is well-formed. Skip per-request tuning on
      // those routes; local-only Ollama models still honour it.
      const isCloud = typeof opts.model === "string" && opts.model.endsWith(":cloud");
      const ollamaOptions: Record<string, unknown> = {};
      if (!isCloud) {
        if (cfg.temperature != null) ollamaOptions.temperature = cfg.temperature;
        if (cfg.top_p != null) ollamaOptions.top_p = cfg.top_p;
        if (cfg.max_tokens != null) ollamaOptions.num_predict = cfg.max_tokens;
        if (cfg.context_size != null) ollamaOptions.num_ctx = cfg.context_size;
      }
      // Same trick on the top-level body: a cloud passthrough that sees
      // `tools: []` for a model that doesn't support tools also barfs
      // on the schema check. Only include `tools` when we have any.
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: toOllamaMessages(msgs),
      };
      if (Object.keys(ollamaOptions).length > 0) {
        body.options = ollamaOptions;
      }
      // keep_alive keeps the local model resident between turns (no cold
      // reload). LOCAL ONLY — the cloud passthrough rejects extra top-level
      // fields the same way it rejects `options` (cryptic 400). Gated here, not
      // in streamOllamaChat, so cloud routes never carry it.
      if (!isCloud) {
        body.keep_alive = "5m";
      }
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
      }
      return await streamOllamaChat(
        `${OLLAMA_BASE}/api/chat`,
        body,
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
