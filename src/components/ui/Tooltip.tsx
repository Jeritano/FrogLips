import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/** Mount once near the app root so all tooltips share one timing controller. */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  /** The hover/focus target. Must be a single focusable element. */
  children: ReactNode;
  /** Tooltip body. */
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Delay before showing (ms). Defaults to the provider's value. */
  delayDuration?: number;
}

/**
 * Accessible tooltip — appears on hover AND keyboard focus (the hand-rolled
 * `title`-attribute tooltips were mouse-only). Radix handles positioning,
 * collision, and `aria-describedby` wiring.
 */
export function Tooltip({ children, content, side = "top", delayDuration }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="ui-tooltip" side={side} sideOffset={6}>
          {content}
          <RadixTooltip.Arrow className="ui-tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
