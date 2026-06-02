/**
 * Roundtable — multiple models take turns on ONE shared transcript until a
 * stop condition. Cloud-first (custom/OpenRouter/Ollama participants); one
 * local Ollama guest is fine. See the locked design (v3): shared history,
 * transcript-in-one-user-message framing, $-budget primary guardrail,
 * graceful per-turn failure, round-robin + director turn control.
 */

/** Backends a roundtable seat can use in v1. MLX/native deferred (they need
 *  server-lifecycle management; cloud + Ollama stream cleanly). */
export type SeatBackend = "custom" | "openrouter" | "ollama";

/** A participant ("seat") at the table. */
export interface Seat {
  /** Stable client id (for React keys + turn attribution). */
  id: string;
  /** Display name / persona handle, e.g. "The Skeptic". */
  name: string;
  /** Hex accent color for the speaker's bubble. */
  color: string;
  /** Backend + model identity. For `custom` this is the CustomBackend id; for
   *  `openrouter` it's the catalogue model id; for `ollama` the model tag. */
  backend: SeatBackend;
  model: string;
  /** Human label of the underlying model (for display when name != model). */
  modelLabel?: string;
  /** Persona system prompt — the role/stance this seat argues. */
  system: string;
  temperature?: number;
  /** Per-turn output cap in tokens (derived from a max-words setting). */
  maxTokens?: number;
}

export type TurnControl = "round-robin" | "director";
export type MemoryMode = "full" | "recent";

export interface StopConditions {
  /** Hard ceiling on full rounds (one round = every seat speaks once). */
  maxRounds: number;
  /** Estimated-token budget for the whole run (input+output across all turns).
   *  The dominant cost lever — input grows each turn. Null = no token cap. */
  maxTokens: number | null;
  /** Estimated USD ceiling (computed from per-model pricing where known).
   *  Null = no $ cap (or pricing unknown). */
  maxUsd: number | null;
}

export interface RoundtableConfig {
  seats: Seat[];
  /** Opening topic / question that seeds the table. */
  topic: string;
  turnControl: TurnControl;
  /** With `director`, this seat sets the agenda every `directorEveryN` turns
   *  (its steering line shows in the transcript). */
  directorSeatId?: string | null;
  directorEveryN?: number;
  memoryMode: MemoryMode;
  /** When `recent`, how many prior turns each recipient sees (full text). */
  recentWindow: number;
  stop: StopConditions;
  /** Preset this config came from (for anti-collapse behavior + analytics). */
  preset?: string;
}

export type TurnStatus = "pending" | "streaming" | "done" | "error" | "skipped";

/** One turn in the shared transcript. */
export interface Turn {
  id: string;
  seatId: string;
  /** Display name captured at turn time (roster snapshot — survives renames). */
  speaker: string;
  color: string;
  text: string;
  status: TurnStatus;
  /** Round index (0-based). Moderator/director turns may share a round. */
  round: number;
  /** Kind: a normal seat turn, the user's moderator injection, or a director
   *  steering line. */
  kind: "seat" | "moderator" | "director";
  error?: string;
  /** Estimated tokens (chars/4) — the plain stream path returns no usage. */
  tokensIn: number;
  tokensOut: number;
  /** Estimated USD for this turn (0 when pricing unknown / local). */
  usd: number;
}

/** Reason a run ended. */
export type RoundtableEndReason =
  | "max_rounds"
  | "token_budget"
  | "usd_budget"
  | "stopped"
  | "all_failed"
  | "error";

export interface RoundtableTotals {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** True if any participant's pricing was unknown (so usd is a lower bound). */
  usdPartial: boolean;
}
