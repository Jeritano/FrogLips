import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the per-turn stream so the engine runs offline. Each seat "replies"
// deterministically; tests can override to throw (failure path).
const streamMock = vi.hoisted(() => ({
  fn: vi.fn(
    async (
      seat: { name: string },
      _msgs: unknown,
      opts: { onDelta: (d: string) => void },
    ) => {
      const text = `point from ${seat.name}`;
      opts.onDelta(text);
      return text;
    },
  ),
}));
vi.mock("../stream", () => ({ streamSeatTurn: streamMock.fn }));

import { runRoundtable } from "../engine";
import type { RoundtableConfig, Seat } from "../types";

const seatA: Seat = {
  id: "a",
  name: "Optimist",
  color: "#0f0",
  backend: "openrouter",
  model: "x/a",
  system: "",
};
const seatB: Seat = {
  id: "b",
  name: "Skeptic",
  color: "#00f",
  backend: "openrouter",
  model: "x/b",
  system: "",
};

function cfg(over: Partial<RoundtableConfig> = {}): RoundtableConfig {
  return {
    seats: [seatA, seatB],
    topic: "T",
    turnControl: "round-robin",
    memoryMode: "full",
    recentWindow: 4,
    stop: { maxRounds: 2, maxTokens: null, maxUsd: null },
    ...over,
  };
}

const noopHooks = {
  onRound: () => {},
  onTurnStart: () => {},
  onTurnDelta: () => {},
  onTurnDone: () => {},
  onTotals: () => {},
};

beforeEach(() => {
  streamMock.fn.mockClear();
  streamMock.fn.mockImplementation(
    async (
      seat: { name: string },
      _m: unknown,
      opts: { onDelta: (d: string) => void },
    ) => {
      const text = `point from ${seat.name}`;
      opts.onDelta(text);
      return text;
    },
  );
});

describe("runRoundtable", () => {
  it("round-robins all seats for maxRounds and ends on max_rounds", async () => {
    const res = await runRoundtable(cfg(), noopHooks, {
      signal: new AbortController().signal,
      prices: {},
    });
    expect(res.reason).toBe("max_rounds");
    // 2 seats × 2 rounds
    expect(res.turns.filter((t) => t.status === "done")).toHaveLength(4);
    expect(res.turns.map((t) => t.speaker)).toEqual([
      "Optimist",
      "Skeptic",
      "Optimist",
      "Skeptic",
    ]);
    expect(res.totals.turns).toBe(4);
    expect(res.totals.tokensOut).toBeGreaterThan(0);
  });

  it("user Stop ends the run as 'stopped'", async () => {
    const ac = new AbortController();
    // Abort after the first turn streams.
    streamMock.fn.mockImplementation(
      async (
        _seat: { name: string },
        _m: unknown,
        opts: { onDelta: (d: string) => void },
      ) => {
        opts.onDelta("x");
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
    );
    const res = await runRoundtable(cfg(), noopHooks, {
      signal: ac.signal,
      prices: {},
    });
    expect(res.reason).toBe("stopped");
  });

  it("$ budget gate refuses to start a turn that would cross the cap", async () => {
    // Price each token; tiny budget → first turn's projection already exceeds it.
    const prices = {
      a: { inPerToken: 1, outPerToken: 1 },
      b: { inPerToken: 1, outPerToken: 1 },
    };
    const res = await runRoundtable(
      cfg({ stop: { maxRounds: 5, maxTokens: null, maxUsd: 0.000001 } }),
      noopHooks,
      {
        signal: new AbortController().signal,
        prices,
      },
    );
    expect(res.reason).toBe("usd_budget");
    expect(res.totals.turns).toBe(0);
  });

  it("token budget gate stops mid-run", async () => {
    const res = await runRoundtable(
      cfg({ stop: { maxRounds: 10, maxTokens: 50, maxUsd: null } }),
      noopHooks,
      {
        signal: new AbortController().signal,
        prices: {},
      },
    );
    expect(res.reason).toBe("token_budget");
  });

  it("one failing seat is skipped; the other continues", async () => {
    streamMock.fn.mockImplementation(
      async (
        seat: { name: string },
        _m: unknown,
        opts: { onDelta: (d: string) => void },
      ) => {
        if (seat.name === "Skeptic") throw new Error("provider 500");
        opts.onDelta("ok");
        return `point from ${seat.name}`;
      },
    );
    const res = await runRoundtable(cfg(), noopHooks, {
      signal: new AbortController().signal,
      prices: {},
    });
    expect(res.reason).toBe("max_rounds");
    expect(
      res.turns.filter((t) => t.status === "done").map((t) => t.speaker),
    ).toEqual(["Optimist", "Optimist"]);
    expect(res.turns.filter((t) => t.status === "error")).toHaveLength(2);
  });

  it("a whole round of failures ends as 'all_failed'", async () => {
    streamMock.fn.mockImplementation(async () => {
      throw new Error("all backends down");
    });
    const res = await runRoundtable(cfg(), noopHooks, {
      signal: new AbortController().signal,
      prices: {},
    });
    expect(res.reason).toBe("all_failed");
  });

  it("RT-3: a single transient failure does NOT end the run (only a whole dead round does)", async () => {
    // First call (Optimist, round 0) fails; everyone else succeeds.
    let calls = 0;
    streamMock.fn.mockImplementation(
      async (
        seat: { name: string },
        _m: unknown,
        opts: { onDelta: (d: string) => void },
      ) => {
        calls++;
        if (calls === 1) throw new Error("transient 503");
        opts.onDelta("ok");
        return `point from ${seat.name}`;
      },
    );
    const res = await runRoundtable(cfg(), noopHooks, {
      signal: new AbortController().signal,
      prices: {},
    });
    expect(res.reason).toBe("max_rounds"); // round 0 still had a success (Skeptic)
    expect(res.turns.filter((t) => t.status === "done").length).toBe(3);
  });

  it("RT-1: a drained moderator injection reaches the next seat's prompt", async () => {
    const seen: string[] = [];
    streamMock.fn.mockImplementation(
      async (
        seat: { name: string },
        msgs: unknown,
        opts: { onDelta: (d: string) => void },
      ) => {
        seen.push(
          (msgs as { content: string }[]).map((m) => m.content).join("\n"),
        );
        opts.onDelta("ok");
        return `point from ${seat.name}`;
      },
    );
    const mod = {
      id: "mod0",
      seatId: "__moderator__",
      speaker: "Moderator",
      color: "#000",
      text: "Focus on enforcement.",
      status: "done" as const,
      round: -1,
      kind: "moderator" as const,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    };
    let drained = false;
    const drainInjections = () => {
      if (drained) return [];
      drained = true;
      return [mod];
    };
    await runRoundtable(
      cfg({ stop: { maxRounds: 1, maxTokens: null, maxUsd: null } }),
      noopHooks,
      {
        signal: new AbortController().signal,
        prices: {},
        drainInjections,
      },
    );
    // The injection drains at round 0 start → it's in the transcript the SECOND
    // seat (Skeptic) sees (the first seat saw it too since drain is pre-loop).
    expect(
      seen.some((p) => p.includes("Moderator: Focus on enforcement.")),
    ).toBe(true);
  });
});
