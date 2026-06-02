import clsx, { type ClassValue } from "clsx";

/**
 * Class-name composer for the UI kit. Thin wrapper over `clsx` so component
 * call sites read `cn("ui-btn", variantClass, className)` and falsy values
 * (conditionals, undefined `className` props) drop out cleanly.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
