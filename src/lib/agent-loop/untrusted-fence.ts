/* ── Untrusted-data fencing ────────────────────────────────────────────────
 *
 * Shared helper for wrapping adversary-controlled text in a `<untrusted-data>`
 * fence before it re-enters an agent loop as context. Used by:
 *   - workflow card handoff (one card's output → the next card's prompt), and
 *   - subagent answers (a child agent's final text → the parent loop).
 *
 * Both are second-order injection vectors: the text came out of another LLM
 * that may have processed attacker-controlled tool/web/MCP content, so it must
 * never be promoted to an instruction or allowed to carry a real role token.
 *
 * Keeping the strip-list + fence shape in ONE place means the two call sites
 * can't drift (a token added for one is added for both).
 */

/** Tokenizer-special role-framing sequences. Many local backends (llama.cpp,
 *  MLX) materialize these as real role tokens when they appear in raw text
 *  input, silently bypassing the prose "treat as data" guardrail. Covers
 *  ChatML, Llama-2/3, Gemma, and Phi framing. */
export const ROLE_FRAMING_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|start_header_id|>",
  "<|end_header_id|>",
  "<|eot_id|>",
  "<|begin_of_text|>",
  "<|end_of_text|>",
  "<|system|>",
  "<|user|>",
  "<|assistant|>",
  "[INST]",
  "[/INST]",
  "<<SYS>>",
  "<</SYS>>",
  // Gemma role framing (no pipe delimiters).
  "<start_of_turn>",
  "<end_of_turn>",
  // Phi-3 turn terminator.
  "<|end|>",
] as const;

/**
 * Strip stray `<untrusted-data>` fence tags (so adversarial text can't "close"
 * the fence early) and neuter tokenizer role-framing sequences (so they can't
 * be promoted to real role tokens). Returns auditable text — replaced spans
 * become a visible `[stripped-role-token]` marker rather than vanishing.
 */
export function stripRoleFraming(text: string): string {
  // Tolerates whitespace + attributes so `</ untrusted-data>` or
  // `<untrusted-data foo="bar">` can't sneak through. Matches open + close.
  let safe = text.replace(/<\s*\/?\s*untrusted-data\b[^>]*>/gi, "");
  for (const tok of ROLE_FRAMING_TOKENS) {
    if (safe.includes(tok)) {
      safe = safe.split(tok).join("[stripped-role-token]");
    }
  }
  return safe;
}

/**
 * Wrap `text` in a `<untrusted-data source="…">` fence after stripping role
 * framing. The caller supplies the `source` label; any DATA-only preamble is
 * the caller's concern (the workflow handoff prepends its own instruction).
 */
export function fenceUntrustedData(text: string, source: string): string {
  const safe = stripRoleFraming(text);
  return `<untrusted-data source="${source}">\n${safe}\n</untrusted-data>`;
}
