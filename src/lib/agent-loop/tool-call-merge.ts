/* ── Streaming tool-call accumulation ──────────────────────────────────────
 *
 * Both Ollama and the OpenAI-compatible MLX endpoint emit tool_calls in
 * pieces — a slot with `function.name` first, then later slots with
 * `function.arguments` fragments, keyed by array index. These helpers merge
 * the chunks into whole `ToolCall`s.
 */

import type { ToolCall } from "../../types";
import type { PartialToolCall } from "./stream-types";

/**
 * Merge an incoming tool_call chunk into the accumulator slot at `index`.
 * Some servers emit `arguments` as a string fragment (concat), others as a
 * full object (replace). Both forms are handled.
 */
export function mergeToolCallChunk(
  acc: PartialToolCall[],
  index: number,
  chunk: Partial<ToolCall> & { function?: Partial<ToolCall["function"]> },
): void {
  let slot = acc[index];
  if (!slot) {
    slot = { function: { name: "", arguments: undefined } };
    acc[index] = slot;
  }
  if (chunk.id !== undefined) slot.id = chunk.id;
  if (chunk.type !== undefined) slot.type = chunk.type;
  if (chunk.function) {
    if (chunk.function.name !== undefined && chunk.function.name !== "") {
      slot.function.name = chunk.function.name;
    }
    if (chunk.function.arguments !== undefined) {
      const a = chunk.function.arguments;
      if (typeof a === "string") {
        slot.function._argStr = (slot.function._argStr ?? "") + a;
        // Attempt to keep arguments parsed as we go; final pass below cleans up.
        slot.function.arguments = slot.function._argStr;
      } else if (a && typeof a === "object") {
        // Object form — replace (Ollama tends to send the whole object in one chunk).
        slot.function.arguments = a as Record<string, unknown>;
        slot.function._argStr = undefined;
      }
    }
  }
}

/** Collapse accumulated partial slots into final, routable `ToolCall`s. */
export function finalizeToolCalls(acc: PartialToolCall[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const slot of acc) {
    if (!slot) continue;
    // Drop slots whose name never arrived — a nameless tool_call is
    // unroutable and would crash dispatch / pollute the audit log.
    if (!slot.function.name) continue;
    // Default to an empty-object literal (string form) when no arguments
    // arrived. Downstream serializers (toOllamaMessages, MLX, native) all
    // need a valid JSON object string; an empty `""` would re-trip cloud
    // routing's "Value looks like object, but can't find closing '}'" reject.
    let args: Record<string, unknown> | string = "{}";
    if (slot.function._argStr !== undefined) {
      // String form — try to JSON.parse, fall back to raw string (dispatch.parseArgs handles both).
      const s = slot.function._argStr;
      try {
        const parsed = JSON.parse(s);
        args = parsed && typeof parsed === "object" ? parsed : s;
      } catch {
        args = s;
      }
    } else if (slot.function.arguments && typeof slot.function.arguments === "object") {
      args = slot.function.arguments as Record<string, unknown>;
    }
    // Mint a stable, schema-safe id. Two failure modes drove this:
    //   1. Empty id — Ollama cloud routing enforces OpenAI's pairing rule
    //      that each `role:"tool"` result reference the assistant's
    //      `tool_calls[].id`; an empty id makes the linkage ambiguous and
    //      trips "Value looks like object, but can't find closing '}'".
    //   2. Funky id from the upstream model — e.g. kimi-k2.6:cloud returns
    //      ids like `functions.web_search:0`. Cloud routers tokenize ids
    //      and reject anything outside `[A-Za-z0-9_-]`; the dot+colon body
    //      gets reflected back as the same opaque 400. Replace any id with
    //      disallowed characters with a fresh `call_<8>`. The matching
    //      `role:"tool"` result message is pushed *after* this finalize
    //      step (in `runner.pushToolResult`), copying `tc.id` directly —
    //      so the sanitized id round-trips on both sides.
    const SAFE_ID = /^[A-Za-z0-9_-]+$/;
    const id =
      slot.id && SAFE_ID.test(slot.id)
        ? slot.id
        : `call_${Math.random().toString(36).slice(2, 10)}`;
    out.push({
      id,
      type: "function",
      function: {
        name: slot.function.name,
        arguments: args,
      },
    });
  }
  return out;
}
