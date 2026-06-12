import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import {
  classify,
  isProfileStale,
  type Headroom,
} from "../lib/hardware-profile";
import type { HardwareProfile, ModelEntry } from "../types";

/* ── useHardwareProfile ──────────────────────────────────────────────────────
 *
 * Reads (and weekly-refreshes) the cached machine profile so any surface can
 * size a model to the hardware. Detection is deduped at module scope: the App
 * and the ModelPicker can both call this hook on the same mount without probing
 * sysctl twice or racing two settings writes.
 */

let _cache: HardwareProfile | null = null;
let _inflight: Promise<HardwareProfile | null> | null = null;

/** Resolve the profile: cached → settings (if fresh) → live detect + persist. */
async function ensureProfile(): Promise<HardwareProfile | null> {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    try {
      const s = await api.settingsGet();
      const cached = s.hardware_profile ?? null;
      if (cached && !isProfileStale(cached.detected_at, now)) {
        _cache = cached;
        return cached;
      }
    } catch {
      /* fall through to a live probe */
    }
    try {
      const info = await api.systemInfo();
      const next: HardwareProfile = { ...info, detected_at: now };
      _cache = next;
      // Persist best-effort; a failed write just means we re-detect next week.
      api.settingsSet({ hardware_profile: next }).catch(() => {});
      return next;
    } catch {
      return null;
    }
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Force a fresh sysctl probe, bypassing the cache (used by "Re-detect"). */
async function redetect(): Promise<HardwareProfile | null> {
  _cache = null;
  return ensureProfile();
}

export function useHardwareProfile() {
  const [profile, setProfile] = useState<HardwareProfile | null>(_cache);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let alive = true;
    void ensureProfile().then((p) => {
      if (alive) setProfile(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const headroomFor = useCallback(
    (model: Pick<ModelEntry, "size_bytes">): Headroom | null =>
      profile ? classify(model, profile) : null,
    [profile],
  );

  const refresh = useCallback(async () => {
    const p = await redetect();
    setProfile(p);
    return p;
  }, []);

  return { profile, headroomFor, refresh };
}
