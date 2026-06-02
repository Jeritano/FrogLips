import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Elevation level 0–3 (maps to --elev-* tokens; 0 = flat, border only). */
  elevation?: 0 | 1 | 2 | 3;
}

const ELEV_CLASS: Record<NonNullable<CardProps["elevation"]>, string> = {
  0: "ui-card--flat",
  1: "ui-card--elev-1",
  2: "ui-card--elev-2",
  3: "ui-card--elev-3",
};

/** Surface container with token-driven background, border, radius, padding.
 *  forwardRef so it can serve as a popover/positioning anchor or be measured. */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ elevation = 0, className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn("ui-card", ELEV_CLASS[elevation], className)}
      {...rest}
    />
  ),
);
Card.displayName = "Card";
