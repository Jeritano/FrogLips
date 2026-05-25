import { useEffect } from "react";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";

/**
 * Restore window size/position from persisted settings on mount, then persist
 * geometry changes (debounced 500ms) on every resize/move.
 *
 * `onGeometryEvent` fires immediately (un-debounced) on each resize/move so the
 * caller can re-query fullscreen state in real time — fullscreen transitions
 * arrive on the same `onResized` stream.
 */
export function useWindowGeometry(onGeometryEvent: () => void): void {
  useEffect(() => {
    const win = getCurrentWindow();
    // Cancellation flag: if the component unmounts before settingsGet
    // resolves (e.g. during rapid detached-window create/destroy, or in
    // StrictMode dev re-mounts), don't apply geometry to a unit that may
    // already be a different webview. The persistGeometry listeners also
    // honor this so a late onResized/onMoved firing post-unmount can't
    // re-trigger a settingsSet against the now-detached window object.
    let cancelled = false;

    // Restore persisted geometry. Reject = leave the OS-default geometry.
    api.settingsGet().then(async (s) => {
      if (cancelled || !s.window) return;
      try {
        if (s.window.width > 200 && s.window.height > 200) {
          if (cancelled) return;
          await win.setSize(new PhysicalSize(Math.round(s.window.width), Math.round(s.window.height)));
        }
        if (s.window.x != null && s.window.y != null) {
          if (cancelled) return;
          await win.setPosition(new PhysicalPosition(Math.round(s.window.x), Math.round(s.window.y)));
        }
      } catch (err) {
        logDiag({
          level: "warn",
          source: "app",
          message: "restoring window geometry failed",
          detail: err,
        });
      }
    }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsGet() rejected — window geometry not restored",
        detail: err,
      }),
    );

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
      offResize.then((f) => f()).catch((err) =>
        logDiag({ level: "info", source: "app", message: "offResize cleanup rejected", detail: err }),
      );
      offMove.then((f) => f()).catch((err) =>
        logDiag({ level: "info", source: "app", message: "offMove cleanup rejected", detail: err }),
      );
      if (saveTimer) window.clearTimeout(saveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
