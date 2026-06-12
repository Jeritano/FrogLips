/**
 * Roundtable engine — the turn loop. Round-robin over the seats on one shared
 * transcript until a stop condition (max rounds / token budget / $ budget /
 * user Stop). Cost is GATED before each turn (never killed mid-stream), one
 * failed turn is skipped rather than killing the run, and each turn has its own
 * timeout. Hooks drive the live UI + persistence (cf. runWorkflow).
 *
 * Director turn-control is plumbed in the config but v1 runs round-robin only;
 * director steering is a fast follow.
 */

import { buildMessages, sanitizeTurn } from "./framing";
import { streamSeatTurn } from "./stream";
import {
  estimateTokens,
  turnUsd,
  projectTurnUsd,
  type PriceTable,
} from "./cost";
import type {
  RoundtableConfig,
  RoundtableEndReason,
  RoundtableTotals,
  Turn,
} from "./types";

const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;
// Local models (Ollama) cold-load or reload between turns — swapping a 7B+
// model can take minutes. A flat cloud-grade 120s cap pre-empted the client's
// own ~300s local-load budget and turned 2-local-model tables into instant
// "all failed". Give local seats a much longer per-turn window.
const LOCAL_PER_TURN_TIMEOUT_MS = 360_000;
const DEFAULT_OUTPUT_CAP_TOKENS = 512;

export interface RoundtableHooks {
  onRound(round: number): void;
  onTurnStart(turn: Turn): void;
  onTurnDelta(turnId: string, delta: string): void;
  onTurnDone(turn: Turn): void;
  onTotals(totals: RoundtableTotals): void;
}

export interface RunRoundtableOpts {
  signal: AbortSignal;
  /** seatId → per-token price (or null when unknown). */
  prices: PriceTable;
  perTurnTimeoutMs?: number;
  /** Drain any pending moderator-injected turns. Called once per round so a
   *  user's mid-run steer is folded into the shared transcript the NEXT seat
   *  sees. Returns + clears the buffer. */
  drainInjections?: () => Turn[];
}

export interface RoundtableResult {
  turns: Turn[];
  reason: RoundtableEndReason;
  totals: RoundtableTotals;
}

function messagesText(parts: { content: string }[]): string {
  return parts.map((m) => m.content).join("\n");
}

/**
 * Run the roundtable to completion (or until stopped). Pure async driver;
 * all I/O is the per-turn stream. Resolves with the full transcript + the
 * reason it ended + final totals.
 */
export async function runRoundtable(
  config: RoundtableConfig,
  hooks: RoundtableHooks,
  opts: RunRoundtableOpts,
): Promise<RoundtableResult> {
  const { signal, prices } = opts;
  // Explicit override applies to all seats; otherwise the per-turn budget is
  // backend-aware (local reloads need far longer than cloud TTFT).
  const optTimeout = opts.perTurnTimeoutMs;
  const turns: Turn[] = [];
  const totals: RoundtableTotals = {
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    usdPartial: false,
  };
  let counter = 0;

  const finishReason = (reason: RoundtableEndReason): RoundtableResult => ({
    turns,
    reason,
    totals,
  });

  for (let round = 0; round < config.stop.maxRounds; round++) {
    if (signal.aborted) return finishReason("stopped");
    hooks.onRound(round);

    // RT-1: fold any moderator injections into the shared transcript so the
    // NEXT seat actually sees the steer (the engine builds prompts from its
    // own `turns`, so a UI-only inject would never reach the models).
    for (const m of opts.drainInjections?.() ?? []) turns.push(m);

    // RT-3: track success WITHIN this round; a whole round with zero successes
    // (provider down / bad keys) ends the run, but a transient single failure
    // that recovers next round must not.
    let roundAttempts = 0;
    let roundSuccess = false;

    for (const seat of config.seats) {
      if (signal.aborted) return finishReason("stopped");

      // Assemble the prompt up front so we can GATE on its projected cost.
      const messages = buildMessages(config, seat, turns);
      const promptTokens = estimateTokens(messagesText(messages));
      const capTokens = seat.maxTokens ?? DEFAULT_OUTPUT_CAP_TOKENS;
      const price = prices[seat.id] ?? null;

      // Budget gate — refuse to START a turn that would cross a cap.
      if (config.stop.maxTokens != null) {
        const projected =
          totals.tokensIn + totals.tokensOut + promptTokens + capTokens;
        if (projected > config.stop.maxTokens)
          return finishReason("token_budget");
      }
      if (config.stop.maxUsd != null) {
        const projected =
          totals.usd + projectTurnUsd(promptTokens, capTokens, price);
        if (projected > config.stop.maxUsd) return finishReason("usd_budget");
      }

      roundAttempts++;
      const turn: Turn = {
        id: `t${counter++}`,
        seatId: seat.id,
        speaker: seat.name,
        color: seat.color,
        text: "",
        status: "streaming",
        round,
        kind: "seat",
        tokensIn: promptTokens,
        tokensOut: 0,
        usd: 0,
      };
      turns.push(turn);
      hooks.onTurnStart(turn);

      // A failed / timed-out / empty turn still SENT its prompt — those input
      // tokens were really consumed. Fold them into totals before skipping so
      // the budget gate (which projects off totals) can't be overshot by a run
      // of failures. Output isn't counted (none was committed).
      const chargeFailedInput = () => {
        totals.tokensIn += turn.tokensIn;
        if (price) totals.usd += turnUsd(turn.tokensIn, 0, price);
        else totals.usdPartial = true;
        hooks.onTotals({ ...totals });
      };

      // Per-turn timeout layered on the run-level abort signal. Backend-aware:
      // local seats get a far longer window for cold-load/reload.
      const seatTimeoutMs =
        optTimeout ??
        (seat.backend === "ollama"
          ? LOCAL_PER_TURN_TIMEOUT_MS
          : DEFAULT_PER_TURN_TIMEOUT_MS);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort);
      // Flag the timeout explicitly: cloud clients don't throw on abort, so a
      // timed-out cloud turn can't be detected from a thrown error alone.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, seatTimeoutMs);
      let acc = "";
      try {
        acc = await streamSeatTurn(seat, messages, {
          temperature: seat.temperature,
          maxTokens: capTokens,
          signal: ac.signal,
          onDelta: (d) => {
            acc += d;
            turn.text = acc;
            hooks.onTurnDelta(turn.id, d);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          // User Stop — mark this turn as skipped and end the run.
          turn.status = "skipped";
          turn.error = "stopped";
          hooks.onTurnDone(turn);
          return finishReason("stopped");
        }
        // Timeout or transport/provider error → skip this seat, keep going.
        turn.status = "error";
        turn.error = timedOut
          ? `timed out after ${Math.round(seatTimeoutMs / 1000)}s`
          : e instanceof Error
            ? e.message
            : String(e);
        hooks.onTurnDone(turn);
        chargeFailedInput();
        continue;
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);

      // RT-2: cloud clients (custom/OpenRouter) DON'T throw on abort — they
      // break the stream and return the partial normally. Don't commit/bill a
      // turn the user Stopped; mark it skipped and end the run.
      if (signal.aborted) {
        turn.status = "skipped";
        turn.error = "stopped";
        hooks.onTurnDone(turn);
        return finishReason("stopped");
      }

      // Per-turn timeout on a CLOUD seat: the client breaks the stream and
      // returns the partial WITHOUT throwing, so the catch never fired. Treat
      // it as an error (don't commit/bill a truncated turn), matching local.
      if (timedOut) {
        turn.status = "error";
        turn.error = `timed out after ${Math.round(seatTimeoutMs / 1000)}s`;
        hooks.onTurnDone(turn);
        chargeFailedInput();
        continue;
      }

      const clean = sanitizeTurn(acc, seat, config.seats);
      turn.text = clean;
      if (!clean) {
        turn.status = "error";
        turn.error = "empty response";
        hooks.onTurnDone(turn);
        chargeFailedInput();
        continue;
      }
      turn.status = "done";
      roundSuccess = true;
      turn.tokensOut = estimateTokens(clean);
      turn.usd = turnUsd(turn.tokensIn, turn.tokensOut, price);
      totals.turns++;
      if (!price) totals.usdPartial = true;
      totals.tokensIn += turn.tokensIn;
      totals.tokensOut += turn.tokensOut;
      totals.usd += turn.usd;
      hooks.onTurnDone(turn);
      hooks.onTotals({ ...totals });
    }

    // RT-3: an entire round where every attempted seat failed → bail.
    if (roundAttempts > 0 && !roundSuccess) return finishReason("all_failed");
  }

  return finishReason("max_rounds");
}
