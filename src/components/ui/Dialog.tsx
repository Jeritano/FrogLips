import * as RadixDialog from "@radix-ui/react-dialog";
import { forwardRef, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * Accessible modal dialog built on Radix. Radix supplies the focus trap,
 * `Esc`/overlay dismissal, `aria-modal`, scroll-lock, and a portal — the
 * things the hand-rolled modal kit had to re-implement. Styling is token-
 * driven via `ui.css`.
 *
 * Usage:
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent title="Delete?" description="...">
 *       …body…
 *       <DialogFooter>…buttons…</DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps {
  /** Accessible title — rendered visibly and wired to `aria-labelledby`. */
  title: ReactNode;
  /** Optional supporting copy wired to `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Destructive-action styling (red header accent). */
  destructive?: boolean;
}

export const DialogContent = forwardRef<
  HTMLDivElement,
  DialogContentProps
>(({ title, description, children, className, destructive }, ref) => (
  <RadixDialog.Portal>
    <RadixDialog.Overlay className="ui-dialog-overlay" />
    <RadixDialog.Content
      ref={ref}
      // When there's no description, formally opt out of `aria-describedby`
      // so Radix doesn't log its "Missing Description" dev warning. When a
      // description IS rendered, omit this so Radix auto-wires the id.
      {...(description == null ? { "aria-describedby": undefined } : {})}
      className={cn(
        "ui-dialog-content",
        destructive && "ui-dialog-content--destructive",
        className,
      )}
    >
      <RadixDialog.Title className="ui-dialog-title">{title}</RadixDialog.Title>
      {description != null && (
        <RadixDialog.Description className="ui-dialog-desc">
          {description}
        </RadixDialog.Description>
      )}
      {children}
    </RadixDialog.Content>
  </RadixDialog.Portal>
));
DialogContent.displayName = "DialogContent";

/** Right-aligned action row for a dialog's buttons. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="ui-dialog-footer">{children}</div>;
}
