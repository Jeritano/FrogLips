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
