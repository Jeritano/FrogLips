/**
 * Inline error bar — shared affordance for the ~9 places across the app
 * that surface a recoverable error inline (sidebar, AboutYou, AgentSettings,
 * ChatWindow, McpSettings, PromptLibrary, MemoryPanel, DetachedChatView,
 * ForkTree). UX re-review H-2 flagged that those sites had inconsistent
 * behaviour: some used "click anywhere to dismiss" with no keyboard
 * affordance, some had `role="alert"` but no explicit close, some had
 * neither.
 *
 * This component is intentionally small and presentational:
 *   - `role="alert"` so screen readers announce on mount.
 *   - An explicit `×` button with `aria-label` so the dismiss is
 *     discoverable + keyboard-operable.
 *   - Optional `onRetry` slot for actionable failures (e.g. retry a
 *     network probe). When omitted, only the close button renders.
 *
 * Styling lives in `src/styles/chat.css` under `.error-bar`. New use
 * sites should NOT inline their own styles — pass `className` to extend.
 */
import { memo } from "react";

interface Props {
  /** The error message to render. Null / empty hides the component. */
  message: string | null | undefined;
  /** Called when the user clicks the × button or presses Escape on it. */
  onDismiss: () => void;
  /**
   * Optional retry callback + label. When provided, a secondary button
   * is rendered to the right of the message before the × button.
   */
  onRetry?: () => void;
  retryLabel?: string;
  /**
   * Optional extra classNames merged with the base `.error-bar`. Useful
   * for spacing tweaks at specific call sites.
   */
  className?: string;
  /** Optional explicit data-testid for the wrapper. */
  testId?: string;
}

function ErrorBarImpl({ message, onDismiss, onRetry, retryLabel, className, testId }: Props) {
  if (!message) return null;
  const cls = className ? `error-bar ${className}` : "error-bar";
  return (
    <div className={cls} role="alert" data-testid={testId ?? "error-bar"}>
      <span className="error-bar-text">{message}</span>
      {onRetry && (
        <button
          type="button"
          className="error-bar-retry"
          onClick={onRetry}
          aria-label={retryLabel ?? "Retry"}
          title={retryLabel ?? "Retry"}
        >
          {retryLabel ?? "Retry"}
        </button>
      )}
      <button
        type="button"
        className="error-bar-close"
        onClick={onDismiss}
        aria-label="Dismiss error"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export const ErrorBar = memo(ErrorBarImpl);
