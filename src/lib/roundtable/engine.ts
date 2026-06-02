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
import { estimateTokens, turnUsd, projectTurnUsd, type PriceTable } from "./cost";
import type {
  RoundtableConfig,
  RoundtableEndReason,
  RoundtableTotals,
  Turn,
} from "./types";

const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;
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
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const turns: Turn[] = [];
  const totals: RoundtableTotals = {
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    usdPartial: false,
  };
  let counter = 0;

  const finishReason = (reason: RoundtableEndReason): RoundtableResult => ({ turns, reason, totals });

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
      if (!price) totals.usdPartial = true;

      // Budget gate — refuse to START a turn that would cross a cap.
      if (config.stop.maxTokens != null) {
        const projected = totals.tokensIn + totals.tokensOut + promptTokens + capTokens;
        if (projected > config.stop.maxTokens) return finishReason("token_budget");
      }
      if (config.stop.maxUsd != null) {
        const projected = totals.usd + projectTurnUsd(promptTokens, capTokens, price);
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

      // Per-turn timeout layered on the run-level abort signal.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => ac.abort(), perTurnTimeoutMs);
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
        turn.error = e instanceof Error ? e.message : String(e);
        hooks.onTurnDone(turn);
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

      const clean = sanitizeTurn(acc, seat, config.seats);
      turn.text = clean;
      turn.status = clean ? "done" : "error";
      if (!clean) {
        turn.status = "error";
        turn.error = "empty response";
        hooks.onTurnDone(turn);
        continue;
      }
      roundSuccess = true;
      turn.tokensOut = estimateTokens(clean);
      turn.usd = turnUsd(turn.tokensIn, turn.tokensOut, price);
      totals.turns++;
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
