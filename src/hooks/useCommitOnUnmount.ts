import { useEffect, useRef } from "react";

/**
 * Run `commit(value)` exactly once on component UNMOUNT, if `value` is non-null
 * at that moment. The latest `value` is read through a ref, and the effect uses
 * an empty dep array, so the cleanup fires ONLY on unmount — never on an
 * intermediate change of `value`.
 *
 * This guards a subtle, dangerous mistake: an effect written as
 * `useEffect(() => () => { if (value) commit(value); }, [value])` runs its
 * cleanup on every change of `value`, capturing the PREVIOUS value. For a
 * soft-delete-with-undo that means clearing the pending state (value → null)
 * fires the captured cleanup and commits the delete the user just undid —
 * silent data loss. Round 12 (2026-05-30) extracted this so the behavior is
 * regression-tested. `commit` is read via a ref too, so an unstable callback
 * identity can't cause the effect to re-run.
 */
export function useCommitOnUnmount<T>(value: T | null | undefined, commit: (v: T) => void): void {
  const valueRef = useRef(value);
  valueRef.current = value;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    return () => {
      const v = valueRef.current;
      if (v != null) commitRef.current(v);
    };
  }, []);
}
