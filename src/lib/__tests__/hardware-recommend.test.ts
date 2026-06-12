import { describe, expect, it } from "vitest";
import { recommendStarter } from "../hardware-recommend";

const CANDIDATES = [
  { id: "small", approxGb: 2 },
  { id: "mid", approxGb: 4.7 },
  { id: "big", approxGb: 13 },
];

describe("recommendStarter", () => {
  it("leads with the largest comfortable model on a roomy Mac", () => {
    const r = recommendStarter(CANDIDATES, 128);
    expect(r.recommended?.id).toBe("big");
    expect(r.fit.get("big")).toBe("comfortable");
  });

  it("steps down to a smaller comfortable model on a modest Mac", () => {
    // 18 GB: big (13×1.3≈16.9, ratio 0.94 thrash), mid (4.7×1.3≈6.1, 0.34 comfy)
    const r = recommendStarter(CANDIDATES, 18);
    expect(r.recommended?.id).toBe("mid");
  });

  it("falls back to the smallest when nothing is comfortable", () => {
    // 4 GB: even small (2×1.3=2.6, ratio 0.65 → tight). prefers a 'tight' over
    // nothing; with only oversized options it returns the smallest.
    const r = recommendStarter(
      [
        { id: "a", approxGb: 8 },
        { id: "b", approxGb: 16 },
      ],
      4,
    );
    expect(r.recommended?.id).toBe("a");
  });

  it("classifies every candidate", () => {
    const r = recommendStarter(CANDIDATES, 18);
    expect(r.fit.size).toBe(3);
    expect(["comfortable", "tight", "thrash", "impossible"]).toContain(
      r.fit.get("small"),
    );
  });

  it("handles an empty list", () => {
    const r = recommendStarter([], 18);
    expect(r.recommended).toBeNull();
    expect(r.fit.size).toBe(0);
  });
});
