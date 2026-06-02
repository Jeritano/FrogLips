import * as RadixSwitch from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

/**
 * Accessible toggle (Radix): `role="switch"`, `aria-checked`, Space/Enter
 * activation, focus ring. Pair with a `<label>` or pass `aria-label`.
 */
export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RadixSwitch.Root>
>(({ className, ...rest }, ref) => (
  <RadixSwitch.Root ref={ref} className={cn("ui-switch", className)} {...rest}>
    <RadixSwitch.Thumb className="ui-switch-thumb" />
  </RadixSwitch.Root>
));
Switch.displayName = "Switch";
