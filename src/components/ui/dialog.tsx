import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Dialog — shadcn's anatomy over Radix's primitive, wearing this app's tokens.
 *
 * The parts and their names are shadcn's (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`,
 * `DialogClose`), so the components read the way the ecosystem's do and anyone who has used shadcn
 * knows this file already. What changed is the styling layer: upstream ships Tailwind utility
 * strings, and this window has its own token system, so each part carries a semantic class the
 * stylesheet owns.
 *
 * What Radix brings that the hand-rolled modals did not have: a focus trap, focus restored to
 * whatever opened the dialog, `aria-modal` and the labelling wired to the title, the rest of the
 * app inert to screen readers while it is open, scroll locking, and — the reason this started —
 * a portal, so no ancestor's filter or transform can reach the dialog.
 *
 * Escape is left to the caller where it matters. Radix closes on Escape by default, which is right
 * for a panel you are reading and wrong for an approval: a dialog that vanishes while the agent is
 * still waiting is a hang with no visible cause. `onEscapeKeyDown` is how that is overridden, and
 * `ApprovalModal` does exactly that.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} className={cn("modal-backdrop", className)} {...props} />
));
DialogOverlay.displayName = "DialogOverlay";

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: "default" | "wide" | "full" }
>(({ className, children, size = "default", ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn("modal", size !== "default" && `modal-${size}`, className)} {...props}>
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dialog-header", className)} {...props} />;
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("dialog-title", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("dialog-description", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";
