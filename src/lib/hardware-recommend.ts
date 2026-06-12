/* ── Hardware-aware starter recommendation ──────────────────────────────────
 *
 * Picks the best starter model for the detected machine so onboarding doesn't
 * recommend something that won't run (or something needlessly tiny on a 128 GB
 * Mac). Reuses the Phase-1 `classify()` tiers so "fit" means the same thing in
 * the wizard as it does in the model picker. Pure — no I/O.
 */

import { classify, type HeadroomTier } from "./hardware-profile";

const GB = 1024 * 1024 * 1024;

export interface StarterCandidate {
  id: string;
  /** Approximate resident size in GiB. */
  approxGb: number;
}

export interface StarterRecommendation<T extends StarterCandidate> {
  /** The model to lead with: largest that runs comfortably, else largest that
   *  is at least "tight", else the smallest (always offer SOMETHING). */
  recommended: T | null;
  /** Per-candidate fit tier (by id). */
  fit: Map<string, HeadroomTier>;
}

/** Classify each candidate against `totalRamGb` and choose the lead pick. */
export function recommendStarter<T extends StarterCandidate>(
  candidates: T[],
  totalRamGb: number,
): StarterRecommendation<T> {
  const fit = new Map<string, HeadroomTier>();
  for (const c of candidates) {
    fit.set(
      c.id,
      classify({ size_bytes: c.approxGb * GB }, { total_ram_gb: totalRamGb })
        .tier,
    );
  }
  const largestFirst = [...candidates].sort((a, b) => b.approxGb - a.approxGb);
  const recommended =
    largestFirst.find((c) => fit.get(c.id) === "comfortable") ??
    largestFirst.find((c) => fit.get(c.id) === "tight") ??
    [...candidates].sort((a, b) => a.approxGb - b.approxGb)[0] ??
    null;
  return { recommended, fit };
}
