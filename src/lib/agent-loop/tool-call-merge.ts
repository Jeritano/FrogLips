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
    let args: Record<string, unknown> | string = "";
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
    out.push({
      id: slot.id ?? "",
      type: "function",
      function: {
        name: slot.function.name,
        arguments: args,
      },
    });
  }
  return out;
}
