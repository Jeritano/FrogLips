import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warn" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "ui-badge--neutral",
  accent: "ui-badge--accent",
  success: "ui-badge--success",
  warn: "ui-badge--warn",
  danger: "ui-badge--danger",
};

/** Small status/label pill. Tones map onto the semantic color tokens.
 *  forwardRef for parity with Card (tooltip/positioning anchors). */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ tone = "neutral", className, ...rest }, ref) => (
    <span
      ref={ref}
      className={cn("ui-badge", TONE_CLASS[tone], className)}
      {...rest}
    />
  ),
);
Badge.displayName = "Badge";
