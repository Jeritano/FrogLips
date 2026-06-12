// Froglips UI kit — token-styled primitives. Import from "components/ui" so
// styling + a11y defaults stay centralized. (The Radix-backed wrappers —
// Dialog/DropdownMenu/Switch/Tabs/Tooltip/Card/IconButton — were removed as
// dead code; nothing imported them and they pulled 5 Radix packages into the
// main bundle. Re-add a wrapper here if a real consumer appears.)
export { cn } from "./cn";
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from "./Button";
export { Input, Textarea, type InputProps, type TextareaProps } from "./Input";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Spinner, Kbd, type SpinnerProps } from "./Spinner";
