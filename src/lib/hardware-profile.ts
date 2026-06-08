/* ── Hardware-aware model sizing ────────────────────────────────────────────
 *
 * Pure helpers that turn a machine's RAM + a model's on-disk size into an
 * honest, computed-not-faked headroom verdict ("Runs comfortably — ~9 GB of
 * your 18 GB free"). Drives the model-picker badge, the warning banner, and the
 * onboarding recommendation. No I/O — the caller supplies the SystemInfo /
 * HardwareProfile (from the `system_info` command, cached in settings).
 */

import type { ModelEntry, SystemInfo } from "../types";

/** Runtime overhead over the resident weights: KV cache + activations +
 *  framework. The on-disk size of a quantized model ≈ its weight footprint, so
 *  the dominant resident term is the weights; this factor covers the rest. */
const RUNTIME_OVERHEAD = 1.3;

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Estimate the RAM (GiB) a model needs resident. From the on-disk size (already
 * quantized) × {@link RUNTIME_OVERHEAD}. Returns 0 when the size is unknown
 * (cloud `:cloud` tags, or a backend that didn't report a size) so the caller
 * can treat it as "no estimate" rather than "fits everything".
 */
export function estimateModelRamGb(model: Pick<ModelEntry, "size_bytes">): number {
  if (!model.size_bytes || model.size_bytes <= 0) return 0;
  return (model.size_bytes / BYTES_PER_GB) * RUNTIME_OVERHEAD;
}

export type HeadroomTier = "comfortable" | "tight" | "thrash" | "impossible";

export interface Headroom {
  tier: HeadroomTier;
  /** Estimated resident RAM the model needs, GiB. 0 = unknown (no estimate). */
  needGb: number;
  /** Rough RAM left after loading (total − need), GiB. */
  freeAfterGb: number;
  /** Short verdict for a badge, e.g. "Runs comfortably". */
  label: string;
  /** One-line detail, e.g. "~9 GB of your 18 GB". Empty when size unknown. */
  detail: string;
  /** Rough cold-load → first-token estimate, seconds (heuristic). */
  etaFirstTokenSec: number;
}

const TIER_LABEL: Record<HeadroomTier, string> = {
  comfortable: "Runs comfortably",
  tight: "Runs, but tight",
  thrash: "Will strain memory",
  impossible: "Too big for this Mac",
};

/**
 * Classify how well `model` fits `machine`. macOS unified memory is shared with
 * the OS + app, so we tier on the fraction of total RAM the model would consume
 * rather than a fixed free figure:
 *   ≤60% comfortable · ≤80% tight · ≤100% thrash · >100% impossible.
 * When the size is unknown the tier is "comfortable" with an empty detail (we
 * can't honestly warn about a model we can't measure — e.g. a cloud tag).
 */
export function classify(
  model: Pick<ModelEntry, "size_bytes">,
  machine: Pick<SystemInfo, "total_ram_gb">,
): Headroom {
  const needGb = estimateModelRamGb(model);
  const total = machine.total_ram_gb || 0;

  // No measurable size, or we don't know the machine → no honest verdict.
  if (needGb <= 0 || total <= 0) {
    return {
      tier: "comfortable",
      needGb: 0,
      freeAfterGb: total,
      label: "",
      detail: "",
      etaFirstTokenSec: 0,
    };
  }

  const ratio = needGb / total;
  let tier: HeadroomTier;
  if (ratio <= 0.6) tier = "comfortable";
  else if (ratio <= 0.8) tier = "tight";
  else if (ratio <= 1.0) tier = "thrash";
  else tier = "impossible";

  const freeAfterGb = total - needGb;
  // Cold load ≈ read weights off SSD (~2.5 GiB/s sustained) + warmup.
  const etaFirstTokenSec = Math.max(1, Math.round(needGb / 2.5 + 1));

  return {
    tier,
    needGb,
    freeAfterGb,
    label: TIER_LABEL[tier],
    detail: `~${fmtGb(needGb)} of your ${fmtGb(total)}`,
    etaFirstTokenSec,
  };
}

/** Format a GiB figure compactly: "9 GB", "0.8 GB", "128 GB". */
export function fmtGb(gb: number): string {
  if (gb <= 0) return "0 GB";
  if (gb < 10) return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
  return `${Math.round(gb)} GB`;
}

/** True when a hardware profile is stale enough to re-detect (>7 days old). */
export function isProfileStale(detectedAtUnixSec: number, nowUnixSec: number): boolean {
  if (!detectedAtUnixSec) return true;
  const WEEK = 7 * 24 * 60 * 60;
  return nowUnixSec - detectedAtUnixSec > WEEK;
}
