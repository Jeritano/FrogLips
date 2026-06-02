import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

/**
 * Accessible dropdown menu (Radix): keyboard roving focus, typeahead, portal,
 * collision-aware positioning, `Esc` close — replacing hand-rolled
 * absolutely-positioned menus that trapped no focus and ignored the keyboard.
 */
export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;
export const DropdownMenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixDropdown.Separator>
>(({ className, ...rest }, ref) => (
  <RadixDropdown.Separator
    ref={ref}
    className={cn("ui-menu-separator", className)}
    {...rest}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixDropdown.Content>
>(({ className, sideOffset = 6, ...rest }, ref) => (
  <RadixDropdown.Portal>
    <RadixDropdown.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn("ui-menu-content", className)}
      {...rest}
    />
  </RadixDropdown.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadixDropdown.Item> & { danger?: boolean }
>(({ className, danger, ...rest }, ref) => (
  <RadixDropdown.Item
    ref={ref}
    className={cn("ui-menu-item", danger && "ui-menu-item--danger", className)}
    {...rest}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";
