import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { runRoundtable, type RoundtableHooks } from "./engine";
import type { PriceTable } from "./cost";
import type { RoundtableConfig, RoundtableEndReason, RoundtableTotals, Turn } from "./types";
import { announce } from "../announce";
import { logDiag } from "../diagnostics";

/**
 * App-level provider that owns a running roundtable so it survives navigating
 * away from the Roundtable view (like the video + workflow providers). Only a
 * full app reload tears down the loop; the transcript built so far stays in
 * state. One run at a time.
 *
 * Delta coalescing (16ms) mirrors the workflow runner: a streaming turn emits
 * many deltas/sec; buffer them and flush once per frame into one setState.
 */

const EMPTY_TOTALS: RoundtableTotals = { turns: 0, tokensIn: 0, tokensOut: 0, usd: 0, usdPartial: false };

interface RoundtableRunCtx {
  running: boolean;
  /** Config of the active/last run (for the live view to render seats). */
  config: RoundtableConfig | null;
  turns: Turn[];
  totals: RoundtableTotals;
  statusLabel: string;
  endReason: RoundtableEndReason | null;
  completedAt: number;
  start(config: RoundtableConfig, prices: PriceTable): boolean;
  inject(text: string): void;
  stop(): void;
  clear(): void;
}

const Ctx = createContext<RoundtableRunCtx | null>(null);

export function RoundtableRunProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<RoundtableConfig | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [totals, setTotals] = useState<RoundtableTotals>(EMPTY_TOTALS);
  const [statusLabel, setStatusLabel] = useState("");
  const [endReason, setEndReason] = useState<RoundtableEndReason | null>(null);
  const [completedAt, setCompletedAt] = useState(0);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const injectCounter = useRef(0);
  // Buffer of moderator turns awaiting fold-in to the engine's transcript.
  // The engine drains this once per round (RT-1) so a mid-run steer reaches
  // the next seat — not just the display.
  const injectionBuf = useRef<Turn[]>([]);

  const start = useCallback((cfg: RoundtableConfig, prices: PriceTable) => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setRunning(true);
    setConfig(cfg);
    setTurns([]);
    setTotals(EMPTY_TOTALS);
    setEndReason(null);
    setStatusLabel("starting");

    const ac = new AbortController();
    abortRef.current = ac;
    announce("Roundtable started");

    // Per-turn delta coalescing.
    const buf = new Map<string, string[]>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (buf.size === 0) return;
      const batch = new Map(buf);
      buf.clear();
      setTurns((ts) =>
        ts.map((t) => {
          const parts = batch.get(t.id);
          return parts ? { ...t, text: t.text + parts.join("") } : t;
        }),
      );
    };
    const schedule = () => {
      if (timer != null) return;
      timer = setTimeout(flush, 16);
    };

    const hooks: RoundtableHooks = {
      onRound: (r) => setStatusLabel(`Round ${r + 1}/${cfg.stop.maxRounds}`),
      onTurnStart: (turn) => setTurns((ts) => [...ts, { ...turn }]),
      onTurnDelta: (id, d) => {
        const cur = buf.get(id) ?? [];
        cur.push(d);
        buf.set(id, cur);
        schedule();
      },
      onTurnDone: (turn) => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        setTurns((ts) => ts.map((t) => (t.id === turn.id ? { ...turn } : t)));
      },
      onTotals: (tot) => setTotals(tot),
    };

    void (async () => {
      try {
        const res = await runRoundtable(cfg, hooks, {
          signal: ac.signal,
          prices,
          drainInjections: () => injectionBuf.current.splice(0),
        });
        setEndReason(res.reason);
        setTotals(res.totals);
      } catch (e) {
        logDiag({ level: "error", source: "roundtable", message: "runRoundtable threw", detail: e });
        setEndReason("error");
      } finally {
        runningRef.current = false;
        abortRef.current = null;
        setRunning(false);
        setStatusLabel("");
        setCompletedAt(Date.now());
        announce("Roundtable ended");
      }
    })();

    return true;
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Moderator injection — append a user steering message to the live transcript
  // (doesn't count toward the round cap; the next seat sees it as context).
  const inject = useCallback((text: string) => {
    // Only meaningful mid-run: guards a post-run inject() from leaking a stale
    // moderator turn into the NEXT run's round-0 drain (injectionBuf is drained
    // by the engine, not reset by start()).
    if (!runningRef.current) return;
    const body = text.trim();
    if (!body) return;
    const mod: Turn = {
      id: `mod${injectCounter.current++}`,
      seatId: "__moderator__",
      speaker: "Moderator",
      color: "#a1a1aa",
      text: body,
      status: "done",
      round: -1,
      kind: "moderator",
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    };
    // Display it immediately AND queue it for the engine to fold into the
    // transcript before the next seat speaks (RT-1).
    injectionBuf.current.push(mod);
    setTurns((ts) => [...ts, mod]);
  }, []);

  const clear = useCallback(() => {
    if (runningRef.current) return;
    setTurns([]);
    setConfig(null);
    setEndReason(null);
    setTotals(EMPTY_TOTALS);
    setStatusLabel("");
  }, []);

  const value = useMemo<RoundtableRunCtx>(
    () => ({ running, config, turns, totals, statusLabel, endReason, completedAt, start, inject, stop, clear }),
    [running, config, turns, totals, statusLabel, endReason, completedAt, start, inject, stop, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRoundtableRun(): RoundtableRunCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useRoundtableRun() must be used inside <RoundtableRunProvider>.");
  }
  return ctx;
}
