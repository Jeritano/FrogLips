import { useCallback, useRef } from "react";

/**
 * Stable-identity callback whose body always sees the latest closure. The
 * returned function never changes reference, so it is safe to pass to
 * `React.memo`'d children or list as a dependency, while the inner `fn`
 * is refreshed on every render. Replaces the render-time ref-mutation
 * pattern (`handlerRef.current = ...` inside an effect/body).
 */
export function useEvent<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
