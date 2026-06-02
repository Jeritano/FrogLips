import * as RadixTabs from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

/**
 * Accessible tabs (Radix): arrow-key navigation, `role="tablist"`/`tab`/
 * `tabpanel`, and automatic `aria-controls` wiring.
 */
export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixTabs.List>
>(({ className, ...rest }, ref) => (
  <RadixTabs.List ref={ref} className={cn("ui-tabs-list", className)} {...rest} />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Trigger
    ref={ref}
    className={cn("ui-tabs-trigger", className)}
    {...rest}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Content
    ref={ref}
    className={cn("ui-tabs-content", className)}
    {...rest}
  />
));
TabsContent.displayName = "TabsContent";
