import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render a full-width block button. */
  block?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ui-btn--primary",
  secondary: "ui-btn--secondary",
  ghost: "ui-btn--ghost",
  danger: "ui-btn--danger",
  subtle: "ui-btn--subtle",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "ui-btn--sm",
  md: "ui-btn--md",
  lg: "ui-btn--lg",
};

/**
 * Token-styled button. Variants + sizes map to `ui.css` classes built on the
 * design tokens (no inline color/spacing). `type` defaults to "button" so a
 * button inside a form doesn't accidentally submit it.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "secondary", size = "md", block, className, type, ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "ui-btn",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        block && "ui-btn--block",
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = "Button";
