import { useCallback, useEffect, useRef, useState } from "react";

/* ── Two-click inline confirm hook ─────────────────────────────────────────
 *
 * Tauri 2's webview disables synchronous dialogs, so `window.confirm()`
 * returns `undefined` and silently short-circuits any `if (!confirm(...))`
 * gate. This hook implements the inline two-click pattern already used by
 * `ModelBrowser` (v0.9.18 `requestRemove` / `confirmDelete` /
 * `confirmTimerRef`) and exposes it as a reusable primitive.
 *
 * Usage:
 *   const c = useTwoClickConfirm();
 *   <button
 *     onClick={() => c.request(String(id), () => doDelete(id))}
 *   >
 *     {c.labelFor(String(id), "Delete")}
 *   </button>
 *
 * First click arms the row (timer starts); second click within the window
 * invokes the callback and resets. Re-arming a different row cancels the
 * previously-armed row's timer.
 */

export interface TwoClickConfirm {
  /** id of the row currently armed (null = nothing armed) */
  armed: string | null;
  /** First call arms (windowMs timer), second call within window invokes
   *  `onConfirm(id)` and resets. */
  request: (id: string, onConfirm: (id: string) => void) => void;
  /** Returns "Click again to confirm" if `id` is armed, otherwise `fallback`. */
  labelFor: (id: string, fallback: string) => string;
  /** Manually cancel the armed state (e.g. when a panel closes). */
  reset: () => void;
}

export function useTwoClickConfirm(windowMs: number = 4000): TwoClickConfirm {
  const [armed, setArmed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    setArmed(null);
  }, [clearTimer]);

  const request = useCallback(
    (id: string, onConfirm: (id: string) => void) => {
      if (armed !== id) {
        // First click on this id (or switching from another armed row): arm it.
        clearTimer();
        setArmed(id);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setArmed(null);
        }, windowMs);
        return;
      }
      // Second click within the window: fire and reset.
      clearTimer();
      setArmed(null);
      onConfirm(id);
    },
    [armed, clearTimer, windowMs],
  );

  const labelFor = useCallback(
    (id: string, fallback: string) =>
      armed === id ? "Click again to confirm" : fallback,
    [armed],
  );

  // Clean up any pending timer on unmount so we don't call setState on a
  // dead component.
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { armed, request, labelFor, reset };
}
