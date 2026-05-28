import { useEffect, useRef } from "react";

export interface ToastProps {
  message: string;
  /** Optional action button (e.g. "Undo"). */
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms. Defaults to 5000. Pass 0 to disable. */
  durationMs?: number;
}

// Reusable bottom-right toast. Auto-dismisses after `durationMs` and exposes
// one optional action. The entrance animation is gated behind
// prefers-reduced-motion in CSS.
export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 5000,
}: ToastProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (durationMs <= 0) return;
    const t = setTimeout(() => dismissRef.current(), durationMs);
    return () => clearTimeout(t);
  }, [durationMs, message]);

  // Audit L-F3 (2026-05-28): role=status (polite live region) so
  // assistive tech announces the toast on mount. The App-level
  // announce() helper still drives most state messaging, but the
  // toast contents (e.g. "Undo delete · Restore") aren't always
  // announced through that path.
  return (
    <div className="toast" role="status" aria-live="polite" aria-label="Notification">
      <span className="toast-msg">{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onAction();
            onDismiss();
          }}
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
