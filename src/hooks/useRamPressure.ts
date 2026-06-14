import { useEffect, useState } from "react";
import { api } from "../lib/tauri-api";

/**
 * RAM-pressure chip (inference wave D): macOS memorystatus level, polled
 * every 5s while visible. Renders ONLY at warn/critical — the early
 * warning before swap turns decode speed to sludge, invisible otherwise.
 *
 * Returns the latest level (defaults to `1` = normal). Polling pauses while
 * the document is hidden so a backgrounded window doesn't churn the IPC.
 */
export function useRamPressure(): number {
  const [ramPressure, setRamPressure] = useState<number>(1);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void api
        .ramPressure()
        .then(([level]) => {
          if (alive) setRamPressure(level);
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return ramPressure;
}
