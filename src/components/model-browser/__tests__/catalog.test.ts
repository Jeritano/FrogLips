import { describe, expect, it } from "vitest";
import {
  fitBadgeLabel,
  fitSortRank,
  fitTier,
  inCategory,
  isCloudEntry,
  parseSizeBytes,
  sizeTier,
  type CatalogEntry,
} from "../catalog";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function entry(over: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: "x",
    label: "X",
    size: "4 GB",
    tags: ["chat"],
    desc: "",
    ...over,
  };
}

describe("parseSizeBytes", () => {
  it("parses GB / MB / TB with decimals", () => {
    expect(parseSizeBytes("18 GB")).toBe(18 * GB);
    expect(parseSizeBytes("4.5 GB")).toBeCloseTo(4.5 * GB);
    expect(parseSizeBytes("815 MB")).toBe(815 * MB);
    expect(parseSizeBytes("1.2 TB")).toBeCloseTo(1.2 * 1024 * GB);
  });
  it("is case + whitespace tolerant", () => {
    expect(parseSizeBytes("  20gb ")).toBe(20 * GB);
  });
  it("returns 0 for cloud / unknown / garbage (no estimate)", () => {
    expect(parseSizeBytes("cloud")).toBe(0);
    expect(parseSizeBytes("")).toBe(0);
    expect(parseSizeBytes("lots")).toBe(0);
    expect(parseSizeBytes("0 GB")).toBe(0);
  });
});

describe("isCloudEntry", () => {
  it("detects cloud via size, tag, or id suffix", () => {
    expect(isCloudEntry(entry({ size: "cloud" }))).toBe(true);
    expect(isCloudEntry(entry({ tags: ["cloud", "chat"] }))).toBe(true);
    expect(isCloudEntry(entry({ id: "gpt-oss:120b-cloud" }))).toBe(true);
    expect(isCloudEntry(entry({ id: "kimi-k2:cloud", size: "cloud" }))).toBe(
      true,
    );
    expect(isCloudEntry(entry({ size: "4 GB", tags: ["chat"] }))).toBe(false);
  });
});

describe("sizeTier", () => {
  it("buckets by absolute on-disk size", () => {
    expect(sizeTier(entry({ size: "2 GB" }))).toBe("small");
    expect(sizeTier(entry({ size: "8 GB" }))).toBe("small");
    expect(sizeTier(entry({ size: "9 GB" }))).toBe("medium");
    expect(sizeTier(entry({ size: "20 GB" }))).toBe("medium");
    expect(sizeTier(entry({ size: "43 GB" }))).toBe("large");
    expect(sizeTier(entry({ size: "cloud" }))).toBe("cloud");
  });
  it("treats unsized non-cloud rows (embeds) as small so they lead", () => {
    expect(sizeTier(entry({ size: "—", tags: ["embed"] }))).toBe("small");
  });
});

describe("inCategory", () => {
  it("reads the curated tag list", () => {
    expect(inCategory(entry({ tags: ["code"] }), "code")).toBe(true);
    expect(inCategory(entry({ tags: ["chat"] }), "code")).toBe(false);
  });
});

describe("fitTier", () => {
  it("returns null when the machine is unknown", () => {
    expect(fitTier(entry({ size: "4 GB" }), null)).toBeNull();
    expect(fitTier(entry({ size: "4 GB" }), { total_ram_gb: 0 })).toBeNull();
  });
  it("returns null for cloud / unsized rows (no RAM verdict)", () => {
    expect(fitTier(entry({ size: "cloud" }), { total_ram_gb: 16 })).toBeNull();
  });
  it("classifies using the shared headroom tiers", () => {
    // 4 GB on disk → ~5.2 GB resident (×1.3). On 64 GB that's comfortable; on
    // 8 GB it's thrash/impossible — exactly the picker/wizard verdict.
    expect(fitTier(entry({ size: "4 GB" }), { total_ram_gb: 64 })).toBe(
      "comfortable",
    );
    const tight = fitTier(entry({ size: "43 GB" }), { total_ram_gb: 64 });
    expect(["tight", "thrash", "impossible"]).toContain(tight);
    expect(fitTier(entry({ size: "404 GB" }), { total_ram_gb: 16 })).toBe(
      "impossible",
    );
  });
});

describe("fitBadgeLabel + fitSortRank", () => {
  it("labels each tier", () => {
    expect(fitBadgeLabel("comfortable")).toBe("Fits");
    expect(fitBadgeLabel("tight")).toBe("Tight");
    expect(fitBadgeLabel("thrash")).toBe("Heavy");
    expect(fitBadgeLabel("impossible")).toBe("Won't fit");
  });
  it("ranks comfortable-first, cloud/unknown last", () => {
    expect(fitSortRank("comfortable")).toBeLessThan(fitSortRank("tight"));
    expect(fitSortRank("tight")).toBeLessThan(fitSortRank("thrash"));
    expect(fitSortRank("thrash")).toBeLessThan(fitSortRank("impossible"));
    expect(fitSortRank("impossible")).toBeLessThan(fitSortRank(null));
  });
});
