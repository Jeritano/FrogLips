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

export interface ArgRepair {
  repaired: Record<string, unknown>;
  /** Which syntax fix recovered it (for audit/telemetry). */
  kind: string;
}

/**
 * Best-effort recovery of malformed tool-call arguments that weak models emit —
 * PURE SYNTAX only (never invents or renames fields, never touches the tool
 * name). Tries, in order: strip a ```json fence, straighten smart quotes, drop
 * trailing commas, single→double quotes (only when no double quotes are
 * present, so strings containing apostrophes aren't corrupted), and wrap a
 * brace-less `key: "val"` object. Returns the parsed object + which fix worked,
 * or null if still unparseable (caller falls back to the raw string, today's
 * behavior). Lets a qwen-abliterated / gemma tool call succeed instead of
 * burning an iteration on a `bad_arguments` reject.
 */
export function attemptRepairArgs(raw: string): ArgRepair | null {
  if (typeof raw !== "string") return null;
  const s0 = raw.trim();
  if (!s0) return null;

  const tryParse = (candidate: string, kind: string): ArgRepair | null => {
    try {
      const p = JSON.parse(candidate);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return { repaired: p as Record<string, unknown>, kind };
      }
    } catch {
      /* keep trying */
    }
    return null;
  };

  // 1. Strip a markdown code fence the model wrapped the JSON in.
  let s = s0;
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    s = fence[1].trim();
    const r = tryParse(s, "fence");
    if (r) return r;
  }

  // 2. Smart quotes → straight.
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // 3. Trailing commas before } or ].
  s = s.replace(/,(\s*[}\]])/g, "$1");
  {
    const r = tryParse(s, "syntax");
    if (r) return r;
  }

  // 4. Single-quoted → double-quoted, ONLY when no double quotes exist (so a
  //    legit apostrophe inside a double-quoted string isn't mangled).
  if (!s.includes('"') && s.includes("'")) {
    const r = tryParse(s.replace(/'/g, '"'), "single-quotes");
    if (r) return r;
  }

  // 5. Brace-less object: `path: "x", recursive: true` → wrap in braces.
  if (!s.startsWith("{")) {
    const wrapped = `{${s}}`;
    const r = tryParse(wrapped, "naked-object");
    if (r) return r;
    if (!wrapped.includes('"') && wrapped.includes("'")) {
      const r2 = tryParse(wrapped.replace(/'/g, '"'), "naked-object");
      if (r2) return r2;
    }
  }

  return null;
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
        // Weak models often emit near-JSON (fences, smart quotes, trailing
        // commas, single quotes). Try a pure-syntax repair before falling back
        // to the raw string (which dispatch would reject as bad_arguments).
        const repaired = attemptRepairArgs(s);
        args = repaired ? repaired.repaired : s;
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
    // Audit L-A1 (2026-05-28): use crypto.randomUUID like the other id
    // mint sites (subagent.makeId, dispatch opIds). The previous
    // Math.random().toString(36).slice(...) gave ~41 bits of entropy —
    // negligible collision risk within a run but a needless inconsistency.
    const id =
      slot.id && SAFE_ID.test(slot.id)
        ? slot.id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
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
