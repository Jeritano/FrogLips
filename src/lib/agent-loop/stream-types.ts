/* ── Shared streaming chat types ───────────────────────────────────────────
 *
 * The result/partial shapes are produced by both backend clients
 * (Ollama NDJSON and MLX OpenAI-SSE) and consumed by the agent runner, so
 * they live here rather than inside one client.
 */

import type { ToolCall } from "../../types";

/** Aggregated result of one streaming tool-calling chat turn. */
export interface StreamChatResult {
  content: string;
  tool_calls: ToolCall[];
  prompt_eval_count?: number;
  eval_count?: number;
}

/** An in-flight tool call being assembled from streamed chunks. */
export interface PartialToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: unknown;
    _argStr?: string;
  };
}
