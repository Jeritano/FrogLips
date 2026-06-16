/* ── Curated catalog helpers ─────────────────────────────────────────────────
 *
 * Pure logic for the RAM-aware "Catalog" tab: turn a catalog entry's
 * human-readable size string ("18 GB", "815 MB", "cloud") into bytes so the
 * SHARED `classify()` headroom classifier (the same one the model picker and
 * setup wizard use) can badge it comfortable / tight / won't-fit, plus the
 * size-tier (small / medium / large) bucketing for grouping. No I/O — callers
 * feed in the machine's RAM.
 */

import { classify, type HeadroomTier } from "../../lib/hardware-profile";
import type { SystemInfo } from "../../types";

/** One curated catalog entry. Mirrors the shape ModelBrowser exports. */
export interface CatalogEntry {
  id: string;
  label: string;
  /** Human-readable on-disk size, e.g. "18 GB", "815 MB", or "cloud". */
  size: string;
  tags: string[];
  desc: string;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Parse a catalog `size` string into bytes for the fit classifier. Handles the
 * "NN GB" / "NN MB" forms the curated list uses (decimal-or-integer numerals).
 * Returns 0 for cloud tags or anything unparseable — `classify()` treats 0 as
 * "no estimate" (an honest no-verdict), so cloud rows never get a false RAM
 * warning. Matches the on-disk → resident convention `estimateModelRamGb` uses
 * (the on-disk quantized size is the dominant resident term).
 */
export function parseSizeBytes(size: string): number {
  if (!size) return 0;
  const m = size.trim().match(/^([\d.]+)\s*(GB|MB|TB)$/i);
  if (!m) return 0; // "cloud" or unknown → no estimate
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (m[2].toUpperCase()) {
    case "TB":
      return value * 1024 * BYTES_PER_GB;
    case "GB":
      return value * BYTES_PER_GB;
    case "MB":
      return value * BYTES_PER_MB;
    default:
      return 0;
  }
}

/** True when the entry is a hosted cloud model (no local download / no RAM). */
export function isCloudEntry(e: CatalogEntry): boolean {
  return (
    e.size.trim().toLowerCase() === "cloud" ||
    e.tags.includes("cloud") ||
    e.id.includes(":cloud") ||
    e.id.endsWith("-cloud")
  );
}

/** Size buckets used to group the catalog visually. */
export type SizeTier = "cloud" | "small" | "medium" | "large";

export const SIZE_TIER_LABEL: Record<SizeTier, string> = {
  cloud: "Cloud (hosted — no download)",
  small: "Small (≤ 8 GB)",
  medium: "Medium (8–24 GB)",
  large: "Large (24 GB+)",
};

/** Order tiers small→large for grouped rendering (cloud last). */
export const SIZE_TIER_ORDER: SizeTier[] = [
  "small",
  "medium",
  "large",
  "cloud",
];

/** Bucket an entry by absolute on-disk size (independent of the user's RAM). */
export function sizeTier(e: CatalogEntry): SizeTier {
  if (isCloudEntry(e)) return "cloud";
  const gb = parseSizeBytes(e.size) / BYTES_PER_GB;
  if (gb <= 0) return "small"; // unknown small files (e.g. embeds) lead
  if (gb <= 8) return "small";
  if (gb <= 24) return "medium";
  return "large";
}

/** A capability category surfaced as a filter chip. */
export type CatalogCategory =
  | "chat"
  | "code"
  | "vision"
  | "reasoning"
  | "embed"
  | "tools";

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  chat: "Chat",
  code: "Coder",
  vision: "Vision",
  reasoning: "Reasoning",
  embed: "Embeddings",
  tools: "Tool use",
};

export const CATEGORY_ORDER: CatalogCategory[] = [
  "chat",
  "code",
  "reasoning",
  "vision",
  "tools",
  "embed",
];

/** Does the entry belong to a capability category? Reads the curated tags. */
export function inCategory(e: CatalogEntry, cat: CatalogCategory): boolean {
  return e.tags.includes(cat);
}

/**
 * The RAM-fit verdict for an entry on a given machine, reusing the shared
 * `classify()` so the badge means EXACTLY what the picker/wizard badges mean.
 * Cloud / unsized rows return null (no honest verdict).
 */
export function fitTier(
  e: CatalogEntry,
  machine: Pick<SystemInfo, "total_ram_gb"> | null,
): HeadroomTier | null {
  if (!machine || !(machine.total_ram_gb > 0)) return null;
  const bytes = parseSizeBytes(e.size);
  if (bytes <= 0) return null; // cloud / unknown — no RAM verdict
  return classify({ size_bytes: bytes }, machine).tier;
}

/** Short badge text for a fit tier — mirrors the wizard's wording. */
export function fitBadgeLabel(tier: HeadroomTier): string {
  switch (tier) {
    case "comfortable":
      return "Fits";
    case "tight":
      return "Tight";
    case "thrash":
      return "Heavy";
    case "impossible":
      return "Won't fit";
  }
}

/**
 * Rank for RAM-aware sorting WITHIN a size tier: comfortable first, then tight,
 * then thrash, then impossible, then cloud/unknown. Lower = shown first.
 */
export function fitSortRank(tier: HeadroomTier | null): number {
  switch (tier) {
    case "comfortable":
      return 0;
    case "tight":
      return 1;
    case "thrash":
      return 2;
    case "impossible":
      return 3;
    default:
      return 4; // cloud / unknown
  }
}
