import { useRef, type ReactNode } from "react";
import { useModalA11y } from "../lib/use-modal-a11y";

interface Props {
  /** Accessible dialog label. */
  ariaLabel: string;
  /** Title row content. */
  title: ReactNode;
  /** Body content between title and actions. */
  children?: ReactNode;
  /** Action buttons (caller owns text + handlers). */
  actions: ReactNode;
  /** Invoked on overlay backdrop click or Escape. */
  onDismiss: () => void;
  /** Extra class on the inner box (e.g. risk-destructive). */
  boxClassName?: string;
  /** Test id on the overlay. */
  "data-testid"?: string;
  /** Pass `false` for modals that focus a custom element themselves
   *  (e.g. an empty textarea the user must fill before submitting). */
  autoFocus?: boolean;
}

/**
 * Reusable agent-style confirmation modal. Consolidates the four structurally
 * identical inline modals from ChatWindow (ask-user, edit, citation-open,
 * tool-confirm): a backdrop overlay that dismisses on outside-click / Escape
 * plus an `aria-modal` dialog box. Each call site supplies its own title,
 * body and action buttons so behavior + copy stay identical.
 */
export function ConfirmDialog({
  ariaLabel,
  title,
  children,
  actions,
  onDismiss,
  boxClassName,
  autoFocus,
  ...rest
}: Props) {
  // Audit H9 (2026-05-27): the four ConfirmDialog instances in ChatWindow
  // (ask-user / edit-message / citation-open / tool-confirm) previously
  // mounted without any focus management. Keyboard-only users tabbed into
  // the underlying ChatWindow with the modal technically open. Worse,
  // on the destructive-tool path the Allow button is disabled until a
  // checkbox is ticked — without auto-focus the user had no keyboard
  // path to the checkbox. Now wired through the shared a11y kit:
  // focus trap, Escape-to-close at the document level (Safari address
  // bar steal-safe), autofocus on open, and focus restoration on close.
  const boxRef = useRef<HTMLDivElement>(null);
  useModalA11y({
    open: true,
    onClose: onDismiss,
    containerRef: boxRef,
    autoFocus,
  });
  return (
    <div
      className="agent-confirm-overlay"
      data-testid={rest["data-testid"]}
      onClick={(e) => e.target === e.currentTarget && onDismiss()}
    >
      <div
        ref={boxRef}
        className={`agent-confirm-box${boxClassName ? ` ${boxClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <div className="agent-confirm-title">{title}</div>
        {children}
        <div className="agent-confirm-actions">{actions}</div>
      </div>
    </div>
  );
}
