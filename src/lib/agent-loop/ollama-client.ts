import { invoke } from "@tauri-apps/api/core";
import type { Message, ToolCall } from "../../types";
import { withInactivityTimeout } from "../signal-utils";
import { readLines } from "../stream-lines";
import {
  finalizeToolCalls,
  mergeToolCallChunk,
  toolCallIndex,
} from "./tool-call-merge";
import type { PartialToolCall, StreamChatResult } from "./stream-types";

export const OLLAMA_BASE = "http://127.0.0.1:11434";
export const RETRY_MAX = 2;
export const RETRY_BACKOFF_MS = 500;

// First-byte / cold-start window. A cloud route (qwen3-coder:480b-cloud, …) can
// queue + spin up a huge remote MoE before the first token; a local heavy model
// cold-loads off disk. Generous so neither is killed before it starts emitting.
const OLLAMA_CONNECT_TIMEOUT_MS = 300_000;
// Between-token idle cap, RE-ARMED on every received line. Replaces the old flat
// 120s TOTAL-request timeout, which aborted a long-but-actively-streaming reply
// mid-flight ("AbortError: Fetch is aborted") — exactly what a 480B cloud model
// doing multi-minute agentic reasoning would trip. Now only a genuinely stalled
// connection (no bytes for this long) aborts.
const OLLAMA_IDLE_TIMEOUT_MS = 120_000;

export type { PartialToolCall, StreamChatResult } from "./stream-types";
export { finalizeToolCalls, mergeToolCallChunk } from "./tool-call-merge";

/* ── Message serialisation ── */

export function toOllamaMessages(msgs: Message[]) {
  return msgs.map((m) => {
    if (m.role === "tool") {
      // OpenAI's current tool-message spec is `{role,content,tool_call_id}`
      // only — the legacy `name` field was removed and the cloud router
      // (kimi-k2.6:cloud, deepseek-v4-pro:cloud, …) rejects payloads that
      // include it with the cryptic "Value looks like object, but can't
      // find closing '}' symbol" 400. Forward `tool_call_id` (required for
      // pairing) and nothing else.
      //
      // Some cloud-routing passthroughs run a heuristic on tool message
      // content: if it starts with `{`, they speculatively parse it as a
      // JSON object and reject the whole request when the parser's
      // single-pass scan doesn't find a matching close brace at the same
      // depth. Our content is *literal text* (a JSON-stringified search
      // result, a directory listing, etc.) — never a structured payload.
      // Prefix it with a newline so the cloud heuristic falls through and
      // treats the content as plain text. The leading `\n` is invisible
      // to the model.
      let content = m.content;
      if (content.length > 0 && content[0] === "{") {
        content = `\n${content}`;
      }
      const toolMsg: Record<string, unknown> = { role: "tool", content };
      if (m.tool_call_id) toolMsg.tool_call_id = m.tool_call_id;
      return toolMsg;
    }
    if (m.tool_calls?.length) {
      // Ollama's `/api/chat` expects `tool_calls[].function.arguments` as a
      // PARSED JSON OBJECT, not a JSON-encoded string. Passing the string
      // form (which is what the OpenAI spec defines) triggers the cryptic
      // 400 "Value looks like object, but can't find closing '}' symbol":
      // Ollama's parser sees a string that looks like an object literal,
      // tries to re-parse it, and the single-pass scan fails when escapes
      // confuse its delimiter tracking.
      //
      // Refs: openclaw/openclaw#46679 + #50689 — the upstream fix that
      // landed for this exact error in another OpenAI-compatible gateway.
      const normalized = m.tool_calls
        // Drop any tool_call that lacks a function name — Ollama refuses
        // the whole request on a single empty-name entry.
        .filter(
          (tc) =>
            tc.function &&
            typeof tc.function.name === "string" &&
            tc.function.name.length > 0,
        )
        .map((tc) => {
          // Coerce arguments to an object. If we already have an object
          // (some streaming paths deliver the parsed form), pass it
          // through. If we have a string, JSON.parse it; on parse failure
          // fall back to `{}` so the round-trip stays well-formed.
          let argsObj: Record<string, unknown> = {};
          const raw = tc.function.arguments;
          if (raw && typeof raw === "object") {
            argsObj = raw as Record<string, unknown>;
          } else if (typeof raw === "string" && raw.trim().length > 0) {
            try {
              const parsed = JSON.parse(raw);
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                argsObj = parsed as Record<string, unknown>;
              }
            } catch {
              argsObj = {};
            }
          }
          // Do NOT random-backfill `id` here — `finalizeToolCalls` mints a
          // stable id at stream-finalize time and `runner.pushToolResult`
          // copies it into the matching `tool_call_id` on the tool result
          // message. Generating a fresh random id per-serialize would break
          // that pairing (assistant tc.id would never match the stored tool
          // message's tool_call_id).
          return {
            ...tc,
            function: { ...tc.function, arguments: argsObj },
          };
        });
      // If every tool_call was filtered out as invalid, fall through to
      // the plain-assistant branch — sending `tool_calls: []` would also
      // trigger the cloud schema reject we saw above.
      if (normalized.length === 0) {
        return { role: "assistant" as const, content: m.content ?? "" };
      }
      return {
        role: "assistant" as const,
        content: m.content ?? "",
        tool_calls: normalized,
      };
    }
    // Vision: Ollama /api/chat accepts `images: [base64...]` alongside text.
    // The base64 must be the raw payload — no `data:` prefix.
    if (m.role === "user" && m.images && m.images.length > 0) {
      return {
        role: "user" as const,
        content: m.content,
        images: m.images.map((img) => img.base64),
      };
    }
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    };
  });
}

/* ── Streaming chat ── */

/**
 * Stream an Ollama /api/chat call. Parses NDJSON lines; fires `onContentChunk`
 * for each non-empty content delta, accumulates tool_calls (merging chunks by
 * index), and returns the final aggregated result.
 *
 * Buffer handling: chunks may split mid-line — `readLines` accumulates the
 * leftover tail across reads and only emits complete `\n`-terminated lines.
 */
export async function streamOllamaChat(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onContentChunk: (delta: string) => void,
): Promise<StreamChatResult> {
  // Inactivity watchdog: arm with the generous first-byte / cold-start window
  // and HOLD it until the first real token arrives, then drop to the per-token
  // idle cadence and re-arm on every line.
  const to = withInactivityTimeout(
    signal,
    OLLAMA_IDLE_TIMEOUT_MS,
    "Ollama stream stalled",
  );
  to.kick(OLLAMA_CONNECT_TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Caller decides keep_alive (agent-chat.ts gates it to LOCAL models — the
    // cloud passthrough 400s on extra top-level fields).
    body: JSON.stringify({ ...(body as object), stream: true }),
    signal: to.signal,
  });
  // Bug fix (low/bug): headers can flush on request-accept while a queued cloud
  // MoE is still spinning up the first token. Re-kicking to the 120s idle cap
  // here would abort that legitimate cold-start. Keep the generous window armed
  // until the first content/tool line; the switch to idle cadence happens in
  // processLine once the stream is actually producing tokens.
  to.kick(OLLAMA_CONNECT_TIMEOUT_MS);
  if (!res.ok) {
    to.clear();
    const errText = await res.text().catch(() => "");
    // Cloud routing (kimi-k2.6:cloud, deepseek-v4-pro:cloud, …) re-validates
    // the body strictly and returns 400 with cryptic JSON-shape errors. Dump
    // the exact outgoing payload so the failure is reproducible without
    // guessing which field tripped the validator. Routes through the Rust
    // `append_diag_log` command — WKWebView console is not user-accessible.
    if (res.status === 400) {
      try {
        const dump = JSON.stringify({ url, err: errText, body });
        // eslint-disable-next-line no-console
        console.error("[ollama-400] body =", dump);
        // 2026-05-26 CI fix: `void invoke(...)` doesn't catch the
        // promise rejection. In vitest (no Tauri runtime, mocked
        // window.__TAURI__) the invoke throws "Cannot read properties
        // of undefined (reading 'invoke')" and bubbles as an unhandled
        // rejection — Vitest then fails the whole run even when every
        // test passed. `.catch(() => undefined)` keeps the call truly
        // best-effort.
        void invoke("append_diag_log", { line: `[ollama-400] ${dump}` }).catch(
          () => undefined,
        );
      } catch {
        /* ignore */
      }
    }
    throw new Error(`Ollama ${res.status}: ${errText}`);
  }
  if (!res.body) {
    to.clear();
    throw new Error("Ollama response has no body");
  }

  let content = "";
  const toolAcc: PartialToolCall[] = [];
  let promptTok: number | undefined;
  let evalTok: number | undefined;
  // Stays armed at the generous cold-start window until the first real
  // content/tool delta lands; flips to the 120s idle cadence thereafter.
  let sawFirstToken = false;
  // Reasoning-model live disclosure: Ollama's /api/chat streams a thinking
  // model's chain-of-thought in a SEPARATE `message.thinking` field. We surface
  // it to the live bubble wrapped in `<think>…</think>` sentinels (MessageList
  // splits it into a collapsed "Thought for a moment" disclosure and never shows
  // the raw tags) — but deliberately keep it OUT of the returned `content`, which
  // is re-sent as agent history: baking the chain-of-thought back into the prompt
  // would balloon context and confuse the narrate-without-acting guard. Display
  // only, mirroring the chat path's intent without the resent-context cost.
  let thinkingOpen = false;

  const processLine = (line: string) => {
    // Any line — including an empty keep-alive — proves the stream is alive, so
    // re-arm the watchdog before doing anything else. Before the first token we
    // re-arm at the generous cold-start window (a queued cloud MoE may emit
    // keep-alives while still spinning up); once tokens flow we use idle cadence.
    to.kick(sawFirstToken ? undefined : OLLAMA_CONNECT_TIMEOUT_MS);
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // skip malformed lines
    }
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg) {
      const c = msg.content;
      const hasContentDelta = typeof c === "string" && c.length > 0;
      // Reasoning span: emit the thinking delta into the live bubble wrapped in
      // `<think>`, closing it the moment real content starts. Not accumulated
      // into `content` (see the `thinkingOpen` declaration above).
      const think = msg.thinking;
      if (typeof think === "string" && think.length > 0 && !hasContentDelta) {
        if (!thinkingOpen) {
          onContentChunk("<think>");
          thinkingOpen = true;
        }
        onContentChunk(think);
      }
      if (hasContentDelta) {
        if (thinkingOpen) {
          onContentChunk("</think>\n\n");
          thinkingOpen = false;
        }
        content += c;
        onContentChunk(c);
      }
      const tcs = msg.tool_calls as
        | Array<Partial<ToolCall> & { index?: number }>
        | undefined;
      if (Array.isArray(tcs)) {
        tcs.forEach((tc, i) => {
          // Cloud nests the slot index under `function.index`; local/MLX use the
          // top-level `index`. toolCallIndex handles both so multi-tool turns
          // don't collapse into slot 0.
          mergeToolCallChunk(toolAcc, toolCallIndex(tc, i), tc);
        });
      }
      // First real content/tool delta observed — from here a >120s silence is a
      // genuine stall, so drop to the idle cadence (re-armed on every line).
      if (!sawFirstToken) {
        const hasContent = typeof c === "string" && c.length > 0;
        const hasTools = Array.isArray(tcs) && tcs.length > 0;
        if (hasContent || hasTools) {
          sawFirstToken = true;
          to.kick();
        }
      }
    }
    if (typeof obj.prompt_eval_count === "number")
      promptTok = obj.prompt_eval_count;
    if (typeof obj.eval_count === "number") evalTok = obj.eval_count;
  };

  try {
    await readLines(res.body.getReader(), processLine);
  } finally {
    to.clear();
  }
  // Close a reasoning-only span (model emitted thinking but no content) so the
  // live bubble's `<think>` sentinel is always balanced.
  if (thinkingOpen) onContentChunk("</think>");

  return {
    content,
    tool_calls: finalizeToolCalls(toolAcc),
    prompt_eval_count: promptTok,
    eval_count: evalTok,
  };
}
