import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";

/**
 * Persist window geometry changes (debounced 500ms) on every resize/move.
 *
 * RESTORE happens on the Rust side now (lib.rs setup hook, perf review C7,
 * 2026-06-09): the window is created hidden and geometry is applied before
 * `show()`, so there's no post-paint 800×600 → saved-size jump and no
 * redundant settingsGet IPC on boot. This hook only writes.
 *
 * `onGeometryEvent` fires immediately (un-debounced) on each resize/move so the
 * caller can re-query fullscreen state in real time — fullscreen transitions
 * arrive on the same `onResized` stream.
 */
export function useWindowGeometry(onGeometryEvent: () => void): void {
  useEffect(() => {
    const win = getCurrentWindow();
    // Cancellation flag: a late onResized/onMoved firing post-unmount (rapid
    // detached-window create/destroy, StrictMode dev re-mounts) must not
    // re-trigger a settingsSet against the now-detached window object.
    let cancelled = false;

    let saveTimer: number | undefined;
    const persistGeometry = () => {
      if (cancelled) return;
      onGeometryEvent();
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const sz = await win.innerSize();
          const pos = await win.outerPosition();
          if (cancelled) return;
          await api.settingsSet({
            window: { width: sz.width, height: sz.height, x: pos.x, y: pos.y },
          });
        } catch (err) {
          logDiag({
            level: "warn",
            source: "app",
            message: "persistGeometry: settingsSet failed",
            detail: err,
          });
        }
      }, 500);
    };

    const offResize = win.onResized(persistGeometry);
    const offMove = win.onMoved(persistGeometry);
    return () => {
      cancelled = true;
      offResize
        .then((f) => f())
        .catch((err) =>
          logDiag({
            level: "info",
            source: "app",
            message: "offResize cleanup rejected",
            detail: err,
          }),
        );
      offMove
        .then((f) => f())
        .catch((err) =>
          logDiag({
            level: "info",
            source: "app",
            message: "offMove cleanup rejected",
            detail: err,
          }),
        );
      if (saveTimer) window.clearTimeout(saveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
