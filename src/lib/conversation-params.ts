/* ── Per-conversation model parameters ────────────────────────────────────
 *
 * A conversation may carry an optional `params` override (temperature,
 * top-p, max tokens, system prompt). The Rust side stores it as a raw JSON
 * string in the `conversations.params` column; these helpers decode/encode
 * that string and apply it to outgoing chat requests.
 *
 * Every field is independently nullable. A `null` field — or no params at
 * all — means "fall back to the backend default", so an un-configured
 * conversation behaves exactly as it did before this feature existed.
 */

import type { ConversationParams } from "../types";

/** All-null params — equivalent to "no overrides". */
export function emptyParams(): ConversationParams {
  return { temperature: null, top_p: null, max_tokens: null, system_prompt: null };
}

function clampNum(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Decode a raw `params` JSON string into a typed {@link ConversationParams}.
 * Bad / missing / partial JSON degrades to all-null rather than throwing —
 * a corrupt column must never break sending a chat.
 */
export function parseConversationParams(
  raw: string | null | undefined,
): ConversationParams {
  if (!raw) return emptyParams();
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyParams();
    obj = parsed as Record<string, unknown>;
  } catch {
    return emptyParams();
  }
  const sys = obj.system_prompt;
  return {
    temperature: clampNum(obj.temperature, 0, 2),
    top_p: clampNum(obj.top_p, 0, 1),
    max_tokens:
      typeof obj.max_tokens === "number" && Number.isFinite(obj.max_tokens)
        ? Math.max(1, Math.floor(obj.max_tokens))
        : null,
    system_prompt: typeof sys === "string" && sys.trim() !== "" ? sys : null,
  };
}

/** True when every field is null (nothing to persist / send). */
export function paramsAreEmpty(p: ConversationParams): boolean {
  return (
    p.temperature == null &&
    p.top_p == null &&
    p.max_tokens == null &&
    p.system_prompt == null
  );
}

/**
 * Encode params for `update_conversation_params`. Returns `null` when every
 * field is unset, so clearing the panel removes the column override entirely.
 */
export function serializeConversationParams(
  p: ConversationParams,
): string | null {
  if (paramsAreEmpty(p)) return null;
  return JSON.stringify({
    temperature: p.temperature,
    top_p: p.top_p,
    max_tokens: p.max_tokens,
    system_prompt: p.system_prompt,
  });
}
