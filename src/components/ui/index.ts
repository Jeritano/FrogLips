// Froglips UI kit — token-styled primitives + Radix-backed accessible
// components. Import from "components/ui" rather than reaching into Radix
// directly so styling + a11y defaults stay centralized.
export { cn } from "./cn";
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export { Input, Textarea, type InputProps, type TextareaProps } from "./Input";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Card, type CardProps } from "./Card";
export { Spinner, Kbd, type SpinnerProps } from "./Spinner";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogFooter,
  type DialogContentProps,
} from "./Dialog";
export { Tooltip, TooltipProvider, type TooltipProps } from "./Tooltip";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./DropdownMenu";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./Tabs";
export { Switch } from "./Switch";
