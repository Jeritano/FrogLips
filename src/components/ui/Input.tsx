import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/** Token-styled text input. `invalid` flips the border to the danger token
 *  and sets `aria-invalid` for assistive tech. */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ invalid, className, ...rest }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn("ui-input", invalid && "ui-input--invalid", className)}
      {...rest}
    />
  ),
);
Input.displayName = "Input";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/** Token-styled multiline input sharing the Input visual contract. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ invalid, className, ...rest }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "ui-input",
        "ui-textarea",
        invalid && "ui-input--invalid",
        className,
      )}
      {...rest}
    />
  ),
);
Textarea.displayName = "Textarea";
