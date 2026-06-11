import { useEffect, useState } from "react";
import { checkForUpdate, type UpdateInfo } from "../lib/updater";

/* ── useUpdateCheck ──────────────────────────────────────────────────────────
 *
 * Silent background update check: once ~90s after launch, then every 24h,
 * throttled to at most once per 6h across restarts. Returns the available
 * update (or null). Never auto-installs — the caller decides how to surface it.
 */

const LAST_KEY = "froglips.lastUpdateCheckAt";
const MIN_GAP_MS = 6 * 60 * 60 * 1000; // 6h
const INITIAL_DELAY_MS = 90_000; // let the app settle before a network poke
const POLL_MS = 24 * 60 * 60 * 1000; // 24h

export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      // 2026-06-11: auto-check is OPT-IN (settings.auto_update_check) while
      // we investigate repeated /Applications bundle corruption+deletion
      // that correlates exactly with this check's 90s post-launch window on
      // freshly-installed builds. Manual "Check for updates" in Settings is
      // unaffected. Re-enable by default once the updater is exonerated.
      try {
        const { api } = await import("../lib/tauri-api");
        const settings = await api.settingsGet();
        if (settings.auto_update_check !== true) return;
      } catch {
        return; // can't read settings — stay safe, skip auto-check
      }
      try {
        const last = Number(localStorage.getItem(LAST_KEY) ?? "0");
        if (Date.now() - last < MIN_GAP_MS) return;
        localStorage.setItem(LAST_KEY, String(Date.now()));
      } catch {
        /* localStorage unavailable — just check anyway */
      }
      const u = await checkForUpdate();
      if (alive && u) setUpdate(u);
    };
    const t = setTimeout(() => void run(), INITIAL_DELAY_MS);
    const iv = setInterval(() => void run(), POLL_MS);
    return () => {
      alive = false;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);

  return update;
}
