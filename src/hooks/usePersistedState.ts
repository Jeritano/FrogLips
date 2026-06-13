import { useEffect, useRef, useState } from "react";

/**
 * `useState` whose value is mirrored to `localStorage`, so it survives both
 * component unmount/remount (e.g. switching the Chat/Images/Workflows tab,
 * which conditionally renders and thus unmounts the view) AND a full app
 * restart.
 *
 * Behaviour matches `useState<T>` exactly, plus:
 *   - Initial render reads `localStorage[key]`; falls back to `initial` when
 *     absent or unparseable (corrupt entry never throws — it's ignored).
 *   - Every value change writes back to `localStorage[key]` as JSON.
 *
 * `key` should be stable for the lifetime of the component. Only JSON-safe
 * values persist (strings, numbers, booleans, plain objects/arrays); functions
 * and class instances do not round-trip.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  /**
   * Optional type-guard run against the parsed value. `JSON.parse` only
   * catches malformed JSON, not a *semantically* stale value (e.g. a model id
   * no longer in the dropdown, persisted by an older build). When the guard
   * rejects the hydrated value, `initial` is used instead.
   */
  validate?: (value: unknown) => value is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Read once on first render. `useRef` pins the resolved initial value + the
  // validator so changing props don't re-trigger the lazy initializer.
  const initialRef = useRef(initial);
  const validateRef = useRef(validate);
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw);
        if (!validateRef.current || validateRef.current(parsed)) {
          return parsed as T;
        }
      }
    } catch {
      /* corrupt / unavailable storage — fall through to the default */
    }
    return initialRef.current;
  });

  // Persist only on genuine change. Skipping the first run avoids re-writing
  // the value we just hydrated on every mount (which, for a per-keystroke
  // state like the prompt, would also churn localStorage on remount).
  const didMount = useRef(false);
  // Track the key the current `state` was hydrated/persisted under. `key` is
  // contractually stable, but if a caller ever passes a dynamic key the lazy
  // initializer won't re-hydrate the new slot — yet this effect would still
  // fire (deps include `key`) and write the OLD state under the NEW key,
  // silently clobbering it. Bailing on a key change makes that destructive
  // write impossible while preserving the read-once contract. [bug/low]
  const keyRef = useRef(key);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    if (keyRef.current !== key) {
      // Key changed: `state` belongs to the previous key, so don't write it
      // into the new slot. Adopt the new key for subsequent writes.
      keyRef.current = key;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* quota / private-mode / unavailable — persistence is best-effort */
    }
  }, [key, state]);

  return [state, setState];
}
