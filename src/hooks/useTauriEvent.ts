import { useEffect, useRef } from "react";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { logDiag } from "../lib/diagnostics";

/**
 * Register a Tauri event listener for the lifetime of an effect.
 *
 * Wraps the hand-rolled `listen(name, fn).then(off => …).catch(logDiag)` plus
 * the unmount-cleanup and "async resolved after unmount" race that otherwise
 * gets re-implemented at every call site:
 *  - if the component unmounts before `listen()` resolves, the resolved
 *    unlisten fn is invoked immediately so the listener never leaks;
 *  - registration failure is logged to diagnostics (never throws);
 *  - the handler is read through a ref so it always sees fresh state without
 *    forcing a re-subscribe; pass `deps` only when the event *name* changes.
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: EventCallback<T>,
  deps: ReadonlyArray<unknown> = [],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let cancelled = false;
    let off: UnlistenFn | undefined;
    listen<T>(eventName, (event) => handlerRef.current(event))
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((err) =>
        logDiag({
          level: "warn",
          source: "tauri-event",
          message: `listener registration failed for "${eventName}"`,
          detail: err,
        }),
      );
    return () => {
      cancelled = true;
      if (off) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, ...deps]);
}
