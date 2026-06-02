import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only controls have no text, so an accessible name must
   *  be supplied for screen readers. */
  "aria-label": string;
  size?: "sm" | "md";
  /** Visually-recessed variant for dense toolbars. */
  ghost?: boolean;
}

/**
 * Square, icon-only button. Enforces `aria-label` at the type level so an
 * unlabeled icon control can't ship (the recurring a11y gap in hand-rolled
 * icon buttons).
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = "md", ghost, className, type, ...rest }, ref) => {
    // The type requires `aria-label`, but `""` satisfies it while leaving the
    // control unnamed. Surface that in dev (the type can't enforce non-empty).
    if (import.meta.env.DEV && !String(rest["aria-label"] ?? "").trim()) {
      console.warn(
        "IconButton: empty aria-label — an icon-only control needs an accessible name",
      );
    }
    return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "ui-icon-btn",
        size === "sm" && "ui-icon-btn--sm",
        ghost && "ui-icon-btn--ghost",
        className,
      )}
      {...rest}
    />
    );
  },
);
IconButton.displayName = "IconButton";
