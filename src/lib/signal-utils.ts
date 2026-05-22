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
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener("abort", () => ctrl.abort(parent.reason), { once: true });
  }
  const t = setTimeout(
    () => ctrl.abort(new DOMException(message, "TimeoutError")),
    timeoutMs,
  );
  ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}
