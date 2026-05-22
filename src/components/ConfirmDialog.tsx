import type { ReactNode } from "react";

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
  ...rest
}: Props) {
  return (
    <div
      className="agent-confirm-overlay"
      data-testid={rest["data-testid"]}
      onClick={(e) => e.target === e.currentTarget && onDismiss()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <div
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
