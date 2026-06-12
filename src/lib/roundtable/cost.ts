/**
 * Cost + token estimation for the roundtable. The plain streaming clients
 * (streamChat/streamNativeChat/streamCustomChat) return NO usage, so we
 * estimate tokens with the standard chars/4 heuristic. That's plenty for a
 * "spend up to $X" guardrail + a live meter — it's a safety rail, not billing.
 *
 * Pricing is per-token USD, keyed by seat. OpenRouter exposes it
 * (prompt_price / completion_price, USD per token, as strings); custom
 * backends + Ollama have no price → null (cost shows as a lower bound / free).
 */

/** Per-token USD pricing for a seat's model. */
export interface SeatPrice {
  inPerToken: number;
  outPerToken: number;
}

/** Map seatId → price (or absent/null when unknown). */
export type PriceTable = Record<string, SeatPrice | null | undefined>;

/** chars/4 token estimate. Deliberately rough; floors at 1 for non-empty. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** USD for a single turn given estimated tokens + the seat's price (0 if
 *  pricing unknown). */
export function turnUsd(
  tokensIn: number,
  tokensOut: number,
  price?: SeatPrice | null,
): number {
  if (!price) return 0;
  return tokensIn * price.inPerToken + tokensOut * price.outPerToken;
}

/**
 * Project the cost of the NEXT turn before running it, so the loop can refuse
 * to start a turn that would blow the budget (never kill mid-stream). Input =
 * the transcript we're about to send; output = the per-turn cap (worst case).
 */
export function projectTurnUsd(
  promptTokens: number,
  maxOutputTokens: number,
  price?: SeatPrice | null,
): number {
  return turnUsd(promptTokens, maxOutputTokens, price);
}

/** Parse an OpenRouter price string (USD per token) into a number; bad/absent
 *  → 0. OpenRouter ships e.g. "0.0000004". */
export function parsePrice(v: unknown): number {
  // Clamp to >= 0: a malformed/negative price would make turnUsd negative,
  // LOWERING totals.usd and potentially letting the maxUsd gate never trip.
  if (typeof v === "number" && Number.isFinite(v)) return v >= 0 ? v : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

/** Format a small USD amount for the meter. <$0.01 shows extra precision. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
