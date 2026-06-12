import { describe, it, expect } from "vitest";
import {
  buildMessages,
  buildSystemPrompt,
  sanitizeTurn,
  visibleTurns,
} from "../framing";
import type { RoundtableConfig, Seat, Turn } from "../types";

const seatA: Seat = {
  id: "a",
  name: "Optimist",
  color: "#0f0",
  backend: "openrouter",
  model: "x/a",
  system: "Be hopeful.",
};
const seatB: Seat = {
  id: "b",
  name: "Skeptic",
  color: "#00f",
  backend: "openrouter",
  model: "x/b",
  system: "Be doubtful.",
};

function cfg(over: Partial<RoundtableConfig> = {}): RoundtableConfig {
  return {
    seats: [seatA, seatB],
    topic: "Should AGI be paused?",
    turnControl: "round-robin",
    memoryMode: "full",
    recentWindow: 4,
    stop: { maxRounds: 3, maxTokens: null, maxUsd: null },
    ...over,
  };
}

function turn(seat: Seat, text: string, round = 0): Turn {
  return {
    id: `t-${seat.id}-${round}`,
    seatId: seat.id,
    speaker: seat.name,
    color: seat.color,
    text,
    status: "done",
    round,
    kind: "seat",
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
  };
}

describe("buildSystemPrompt", () => {
  it("names the seat, lists others, embeds topic + persona + rules", () => {
    const s = buildSystemPrompt(cfg(), seatB);
    expect(s).toContain("You are Skeptic");
    expect(s).toContain("Other participants: Optimist");
    expect(s).toContain("Should AGI be paused?");
    expect(s).toContain("Be doubtful.");
    expect(s).toContain("Speak ONLY as Skeptic");
  });
});

describe("buildMessages", () => {
  it("opener: no transcript yet → asks for an initial position", () => {
    const msgs = buildMessages(cfg(), seatA, []);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("opening the roundtable");
  });

  it("non-opener: folds prior turns into one user message", () => {
    const turns = [
      turn(seatA, "AGI is steerable as we build."),
      turn(seatB, "Steering is unproven."),
    ];
    const msgs = buildMessages(cfg(), seatA, turns);
    expect(msgs[1].content).toContain("Conversation so far:");
    expect(msgs[1].content).toContain(
      "Optimist: AGI is steerable as we build.",
    );
    expect(msgs[1].content).toContain("Skeptic: Steering is unproven.");
    expect(msgs[1].content).toContain("Now respond as Optimist.");
  });
});

describe("visibleTurns", () => {
  const turns = [
    turn(seatA, "1"),
    turn(seatB, "2"),
    turn(seatA, "3"),
    turn(seatB, "4"),
    turn(seatA, "5"),
  ];
  it("full = all done turns", () => {
    expect(visibleTurns(cfg({ memoryMode: "full" }), turns)).toHaveLength(5);
  });
  it("recent = last K turns", () => {
    const v = visibleTurns(
      cfg({ memoryMode: "recent", recentWindow: 2 }),
      turns,
    );
    expect(v.map((t) => t.text)).toEqual(["4", "5"]);
  });
  it("drops non-done / empty turns", () => {
    const withBad = [
      ...turns,
      { ...turn(seatB, ""), status: "error" as const },
    ];
    expect(visibleTurns(cfg(), withBad)).toHaveLength(5);
  });
});

describe("sanitizeTurn", () => {
  it("strips a leaked leading self-prefix", () => {
    expect(sanitizeTurn("Skeptic: I doubt it.", seatB, [seatA, seatB])).toBe(
      "I doubt it.",
    );
  });
  it("trims a hijacked second speaker", () => {
    const raw = "I doubt it.\nOptimist: But consider the upside.";
    expect(sanitizeTurn(raw, seatB, [seatA, seatB])).toBe("I doubt it.");
  });
  it("keeps a mid-content quote that is NOT a line-start speaker turn", () => {
    const raw = "As Optimist argued, steering works — but I disagree.";
    expect(sanitizeTurn(raw, seatB, [seatA, seatB])).toBe(raw);
  });
  it("trims a Moderator/Director hijack too", () => {
    const raw = "My point stands.\nModerator: Let's move on.";
    expect(sanitizeTurn(raw, seatB, [seatA, seatB])).toBe("My point stands.");
  });
  it("leaves a clean single-speaker turn untouched", () => {
    const raw = "A multi-line\nreply with no speaker prefixes.";
    expect(sanitizeTurn(raw, seatB, [seatA, seatB])).toBe(raw);
  });
  it("keeps a vocative addressing another participant (not a hijack)", () => {
    // Lowercase / second-person continuation after the colon = the speaker
    // addressing someone, NOT writing their turn — must not be truncated.
    const raw =
      "My plan holds.\nOptimist: you ignore the compounding risk that sinks it.";
    expect(sanitizeTurn(raw, seatB, [seatA, seatB])).toBe(raw);
  });
  it("never manufactures an empty turn — falls back to the original", () => {
    // A reply that is only the self-prefix would strip to "" — must fall back
    // to the original so the engine never mislabels it "empty response".
    expect(sanitizeTurn("Skeptic:", seatB, [seatA, seatB])).toBe("Skeptic:");
    expect(
      sanitizeTurn("Skeptic: ", seatB, [seatA, seatB]).length,
    ).toBeGreaterThan(0);
  });
});
