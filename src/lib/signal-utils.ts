/* ── Shared abort-signal helpers ───────────────────────────────────────────
 *
 * One implementation of "parent signal + timeout" used by every streaming
 * client. Each call site keeps its own timeout VALUE (Ollama 120s request
 * cap, MLX 300s connect cap) — only the wiring is shared.
 */

export interface TimeoutSignal {
  /** Combined signal: aborts on parent abort OR on timeout. */
  signal: AbortSignal;
  /** Cancels the pending timeout (call once headers/response arrive). */
  clear: () => void;
}

/**
 * Build an AbortSignal that aborts when `parent` aborts or after `timeoutMs`.
 * The timeout fires a `TimeoutError` DOMException with `message` so callers
 * can distinguish a timeout from a user abort.
 */
export function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message = "request timed out",
): TimeoutSignal {
  const ctrl = new AbortController();
  // Audit M-A3 (2026-05-27): the parent-abort forwarder used to be
  // `parent.addEventListener("abort", ..., { once: true })`. The agent
  // loop's signal lives for the entire ~40-iteration run; repeated
  // streamOllamaChat calls piled up dead listeners on it (the timeout
  // path completes normally → {once:true} never fires → forwarder
  // never disposed). Track the forwarder + tear it down explicitly
  // when the combined signal aborts or `clear()` is called.
  let onParentAbort: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) {
      ctrl.abort(parent.reason);
    } else {
      onParentAbort = () => ctrl.abort(parent.reason);
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const t = setTimeout(
    () => ctrl.abort(new DOMException(message, "TimeoutError")),
    timeoutMs,
  );
  const dispose = () => {
    clearTimeout(t);
    if (parent && onParentAbort) {
      parent.removeEventListener("abort", onParentAbort);
      onParentAbort = null;
    }
  };
  ctrl.signal.addEventListener("abort", dispose, { once: true });
  return { signal: ctrl.signal, clear: dispose };
}
