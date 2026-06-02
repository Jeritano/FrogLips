import type { ReactNode } from "react";

interface Props {
  /** Optional icon (emoji or small SVG). Rendered above the heading at 24px. */
  icon?: ReactNode;
  /** Primary heading — terse, action-oriented ("No conversations yet"). */
  heading: string;
  /** Sub-copy under the heading — single sentence, optional. */
  sub?: ReactNode;
  /** Optional CTA rendered below the sub. Caller owns the button. */
  cta?: ReactNode;
  /** Pass through to attach test ids / variant flags. */
  className?: string;
  "data-testid"?: string;
}

/**
 * Reusable empty-state card. Replaces the scattered "centered gray text"
 * pattern across mb-empty, dashboard-empty, memory-empty, hfl-empty etc.
 *
 * Keeps the layout consistent (icon → heading → sub → CTA) and uses the
 * theme tokens so light + dark both render. Caller decides when to mount —
 * the component itself never reads any state.
 */
export function EmptyState({ icon, heading, sub, cta, className, ...rest }: Props) {
  return (
    <div
      className={`empty-state${className ? ` ${className}` : ""}`}
      role="status"
      data-testid={rest["data-testid"]}
    >
      {icon != null && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
      <div className="empty-state-heading">{heading}</div>
      {sub && <div className="empty-state-sub">{sub}</div>}
      {cta && <div className="empty-state-cta">{cta}</div>}
    </div>
  );
}
