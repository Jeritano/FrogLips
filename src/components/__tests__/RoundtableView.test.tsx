import { describe, expect, it } from "vitest";
import {
  newSeat,
  SEAT_COLORS,
  isDraftSeatArray,
  isSavedTableArray,
} from "../RoundtableView";

/*
 * Pins two RoundtableView units that have no UI surface worth mounting:
 *  - newSeat's index discipline. The id, the "Seat N" label, and the color must
 *    all derive from the SAME counter read. A regression (post-increment reused
 *    for name/color) shifted the label and color one seat out of step; this
 *    asserts id-index ↔ name ↔ color stay aligned.
 *  - isDraftSeatArray / isSavedTableArray. These guard what gets rehydrated from
 *    persisted local state, so malformed/old data must be rejected, not loaded.
 */

function idIndex(id: string): number {
  const m = /^s(\d+)-/.exec(id);
  if (!m) throw new Error(`unexpected seat id: ${id}`);
  return Number(m[1]);
}

describe("newSeat — index alignment", () => {
  it("derives id-index, label, and color from one counter read", () => {
    const s = newSeat();
    const i = idIndex(s.id);
    expect(s.name).toBe(`Seat ${i + 1}`);
    expect(s.color).toBe(SEAT_COLORS[i % SEAT_COLORS.length]);
  });

  it("advances the counter by exactly one per call", () => {
    const a = newSeat();
    const b = newSeat();
    expect(idIndex(b.id)).toBe(idIndex(a.id) + 1);
    // label tracks the same step (the off-by-one made these diverge)
    expect(Number(b.name.replace("Seat ", ""))).toBe(
      Number(a.name.replace("Seat ", "")) + 1,
    );
  });

  it("a persona seat takes its name/system but still consumes a color slot", () => {
    const persona = { name: "The Skeptic", system: "Stress-test every claim." };
    const s = newSeat(persona);
    const i = idIndex(s.id);
    expect(s.name).toBe("The Skeptic");
    expect(s.system).toBe("Stress-test every claim.");
    expect(s.color).toBe(SEAT_COLORS[i % SEAT_COLORS.length]);
  });

  it("cycles colors past the palette length", () => {
    // Walk a full palette cycle and assert color == colors[index % len] holds
    // across the wrap.
    for (let k = 0; k < SEAT_COLORS.length + 2; k++) {
      const s = newSeat();
      expect(s.color).toBe(SEAT_COLORS[idIndex(s.id) % SEAT_COLORS.length]);
    }
  });
});

describe("persisted-state type guards", () => {
  it("accepts a well-formed draft-seat array", () => {
    expect(isDraftSeatArray([{ id: "s0-1", optionKey: "ollama::m" }])).toBe(
      true,
    );
    expect(isDraftSeatArray([])).toBe(true);
  });

  it("rejects non-arrays and malformed seat entries", () => {
    expect(isDraftSeatArray(null)).toBe(false);
    expect(isDraftSeatArray({})).toBe(false);
    expect(isDraftSeatArray([{ id: "s0" }])).toBe(false); // missing optionKey
    expect(isDraftSeatArray(["nope"])).toBe(false);
  });

  it("accepts a well-formed saved-table array", () => {
    expect(isSavedTableArray([{ id: "t1", name: "Mine", seats: [] }])).toBe(
      true,
    );
  });

  it("rejects saved tables missing required shape", () => {
    expect(isSavedTableArray(null)).toBe(false);
    expect(isSavedTableArray([{ id: "t1", name: "Mine" }])).toBe(false); // no seats
    expect(isSavedTableArray([{ id: "t1", seats: [] }])).toBe(false); // no name
    expect(isSavedTableArray([{ name: "Mine", seats: "x" }])).toBe(false); // seats not array
  });
});
