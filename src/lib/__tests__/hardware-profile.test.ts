import { describe, expect, it } from "vitest";
import {
  classify,
  estimateModelRamGb,
  fmtGb,
  isProfileStale,
  suggestSmallerModel,
} from "../hardware-profile";
import type { ModelEntry } from "../../types";

const GB = 1024 * 1024 * 1024;

const m = (id: string, gb: number): ModelEntry => ({
  id,
  size_bytes: gb * GB,
  backend: "ollama",
});

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

describe("suggestSmallerModel", () => {
  const mac18 = { total_ram_gb: 18 };
  // On 18 GB, "comfortable" = need ≤ 60% = 10.8 GB ⇒ on-disk ≤ ~8.3 GB.
  const list = [
    m("big:70b", 14), // failed model (too big)
    m("mid:13b", 8), // comfortable (10.4 GB need) and smaller
    m("small:7b", 4), // comfortable but smaller than mid
    m("tiny:1b", 1),
  ];

  it("picks the largest comfortable model smaller than the one that failed", () => {
    const s = suggestSmallerModel("big:70b", list, mac18);
    expect(s?.id).toBe("mid:13b");
  });

  it("returns null when the machine is unknown", () => {
    expect(suggestSmallerModel("big:70b", list, null)).toBeNull();
    expect(suggestSmallerModel("big:70b", list, { total_ram_gb: 0 })).toBeNull();
  });

  it("returns null when nothing comfortable is smaller", () => {
    // Only the failed model + larger ones present.
    const onlyBig = [m("big:70b", 14), m("huge:120b", 24)];
    expect(suggestSmallerModel("big:70b", onlyBig, mac18)).toBeNull();
  });

  it("skips candidates with unknown size (cloud/native rows)", () => {
    const withCloud = [m("big:70b", 14), m("cloud", 0)];
    expect(suggestSmallerModel("big:70b", withCloud, mac18)).toBeNull();
  });

  it("never suggests the failed model itself", () => {
    const s = suggestSmallerModel("mid:13b", list, mac18);
    expect(s?.id).not.toBe("mid:13b");
    expect(s?.id).toBe("small:7b");
  });
});
