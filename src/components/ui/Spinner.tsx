import { cn } from "./cn";

export interface SpinnerProps {
  size?: "sm" | "md";
  className?: string;
  /** Accessible label; defaults to "Loading". */
  label?: string;
}

/** Token-styled indeterminate spinner. Respects prefers-reduced-motion via
 *  the global guard in tokens.css. */
export function Spinner({ size = "sm", className, label = "Loading" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("ui-spinner", size === "md" && "ui-spinner--md", className)}
    />
  );
}

/** Inline keyboard key hint, e.g. ⌘K. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
