import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Platform + fullscreen chrome bookkeeping.
 *
 * Writes `data-platform` (mac/win/linux/other) on <html> so CSS can swap the
 * top padding for the macOS traffic lights, and keeps `data-fullscreen` in
 * sync so the hamburger button can slide into the freed space when the
 * traffic lights vanish in native fullscreen.
 *
 * Returns `updateFullscreen` so the geometry hook can re-query immediately
 * (un-debounced) off the same `onResized` stream that reports fullscreen
 * transitions.
 */
export function usePlatformChrome(): { updateFullscreen: () => Promise<void> } {
  const updateFullscreen = async () => {
    try {
      const fs = await getCurrentWindow().isFullscreen();
      document.documentElement.dataset.fullscreen = fs ? "true" : "false";
    } catch {
      document.documentElement.dataset.fullscreen = "false";
    }
  };

  useEffect(() => {
    // navigator.userAgent is deterministic per host platform in the Tauri
    // webview, so it's enough to brand <html> for the CSS top-padding swap.
    const ua = navigator.userAgent || "";
    const platform = /Mac/i.test(ua)
      ? "mac"
      : /Win/i.test(ua)
        ? "win"
        : /Linux/i.test(ua)
          ? "linux"
          : "other";
    document.documentElement.dataset.platform = platform;
    void updateFullscreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { updateFullscreen };
}
