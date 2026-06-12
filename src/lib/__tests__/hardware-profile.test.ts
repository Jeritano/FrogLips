import { describe, expect, it } from "vitest";
import {
  classify,
  estimateModelRamGb,
  fmtGb,
  isProfileStale,
} from "../hardware-profile";

const GB = 1024 * 1024 * 1024;

describe("estimateModelRamGb", () => {
  it("is on-disk size × runtime overhead", () => {
    expect(estimateModelRamGb({ size_bytes: 10 * GB })).toBeCloseTo(13, 5);
    expect(estimateModelRamGb({ size_bytes: 4 * GB })).toBeCloseTo(5.2, 5);
  });
  it("returns 0 for unknown/zero size (e.g. cloud tags)", () => {
    expect(estimateModelRamGb({ size_bytes: 0 })).toBe(0);
    expect(estimateModelRamGb({ size_bytes: -1 })).toBe(0);
  });
});

describe("classify", () => {
  const mac18 = { total_ram_gb: 18 };

  it("comfortable when the model needs ≤60% of RAM", () => {
    const h = classify({ size_bytes: 4 * GB }, mac18); // 5.2 / 18 ≈ 0.29
    expect(h.tier).toBe("comfortable");
    expect(h.label).toBe("Runs comfortably");
    expect(h.detail).toContain("of your 18 GB");
    expect(h.freeAfterGb).toBeGreaterThan(0);
  });

  it("tight in the 60–80% band", () => {
    const h = classify({ size_bytes: 10 * GB }, mac18); // 13 / 18 ≈ 0.72
    expect(h.tier).toBe("tight");
  });

  it("thrash in the 80–100% band", () => {
    const h = classify({ size_bytes: 13 * GB }, mac18); // 16.9 / 18 ≈ 0.94
    expect(h.tier).toBe("thrash");
  });

  it("impossible above 100%", () => {
    const h = classify({ size_bytes: 16 * GB }, mac18); // 20.8 / 18 ≈ 1.16
    expect(h.tier).toBe("impossible");
    expect(h.label).toBe("Too big for this Mac");
    expect(h.freeAfterGb).toBeLessThan(0);
  });

  it("a big model is still comfortable on a big machine", () => {
    const h = classify({ size_bytes: 40 * GB }, { total_ram_gb: 128 });
    expect(h.tier).toBe("comfortable");
  });

  it("no honest verdict when size or machine is unknown", () => {
    expect(classify({ size_bytes: 0 }, mac18).label).toBe("");
    expect(classify({ size_bytes: 4 * GB }, { total_ram_gb: 0 }).label).toBe(
      "",
    );
  });

  it("estimates a cold-load ETA for a sized model", () => {
    expect(
      classify({ size_bytes: 10 * GB }, mac18).etaFirstTokenSec,
    ).toBeGreaterThan(0);
  });
});

describe("fmtGb", () => {
  it("formats compactly", () => {
    expect(fmtGb(0.8)).toBe("0.8 GB");
    expect(fmtGb(9)).toBe("9 GB");
    expect(fmtGb(9.5)).toBe("9.5 GB");
    expect(fmtGb(128)).toBe("128 GB");
    expect(fmtGb(0)).toBe("0 GB");
  });
});

describe("isProfileStale", () => {
  const now = 1_000_000_000;
  it("fresh profile is not stale", () => {
    expect(isProfileStale(now - 60, now)).toBe(false);
  });
  it("older than a week is stale", () => {
    expect(isProfileStale(now - 8 * 24 * 3600, now)).toBe(true);
  });
  it("missing timestamp is stale", () => {
    expect(isProfileStale(0, now)).toBe(true);
  });
});
