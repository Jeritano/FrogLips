import type { Message } from "../types";
import type { ChatChunk, ReplyUsage } from "./mlx-client";
import { toOllamaMessages } from "./agent-loop/ollama-client";
import { withInactivityTimeout } from "./signal-utils";

/*
 * Plain-chat client for LOCAL Ollama via the native /api/chat endpoint
 * (inference perf review 2026-06-11, finding O2).
 *
 * Why not /v1/chat/completions like MLX: Ollama's OpenAI-compat endpoint
 * does not accept `num_ctx` AT ALL, so plain chat ran at the daemon's
 * default context (4096 on older daemons) while applyContextBudget packed
 * prompts for the model's full window — everything past the daemon's limit
 * was silently head-truncated, dropping the persona/system prompt with no
 * error. /api/chat takes the full options surface and reports exact token
 * counts + decode timings on its done-frame (which feeds the per-reply
 * perf footer).
 *
 * Cloud-routed (:cloud) models must NOT come through here — the cloud
 * passthrough rejects bodies with extra top-level fields. The caller gates.
 */

const STREAM_CONNECT_TIMEOUT_MS = 300_000; // cold model load can take minutes
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface OllamaPlainOpts {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Resolved per-model context window — MUST match the budgeter's number. */
  numCtx?: number;
  /** Ollama keep_alive ("5m" | "30m" | "-1"). */
  keepAlive?: string;
  signal?: AbortSignal;
}

export async function* streamOllamaPlain(
  host: string,
  port: number,
  model: string,
  messages: Message[],
  opts: OllamaPlainOpts = {},
): AsyncGenerator<ChatChunk> {
  const options: Record<string, unknown> = {};
  if (opts.numCtx != null) options.num_ctx = opts.numCtx;
  if (opts.maxTokens != null) options.num_predict = opts.maxTokens;
  if (opts.temperature != null) options.temperature = opts.temperature;
  if (opts.topP != null) options.top_p = opts.topP;

  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: toOllamaMessages(messages),
    options,
  };
  if (opts.keepAlive) body.keep_alive = opts.keepAlive;

  const to = withInactivityTimeout(
    opts.signal,
    STREAM_IDLE_TIMEOUT_MS,
    "Ollama stream stalled",
  );
  to.kick(STREAM_CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: to.signal,
    });
    to.kick();
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${txt}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const MAX_BUF = 1 << 20;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      to.kick();
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_BUF) {
        const lastNl = buf.lastIndexOf("\n", buf.length - MAX_BUF);
        buf = lastNl >= 0 ? buf.slice(lastNl + 1) : "";
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // partial/garbled frame — NDJSON resyncs on next line
        }
        const msg = json.message as { content?: string } | undefined;
        if (msg?.content) {
          yield { delta: msg.content, done: false };
        }
        if (json.done === true) {
          const nsToMs = (v: unknown) =>
            typeof v === "number" && v > 0 ? Math.round(v / 1e6) : undefined;
          const usage: ReplyUsage = {
            prompt_tokens:
              typeof json.prompt_eval_count === "number"
                ? json.prompt_eval_count
                : undefined,
            completion_tokens:
              typeof json.eval_count === "number" ? json.eval_count : undefined,
            eval_duration_ms: nsToMs(json.eval_duration),
            prompt_eval_duration_ms: nsToMs(json.prompt_eval_duration),
            load_duration_ms: nsToMs(json.load_duration),
          };
          yield { delta: "", done: true, usage };
          return;
        }
      }
    }
    yield { delta: "", done: true };
  } finally {
    to.clear();
  }
}
