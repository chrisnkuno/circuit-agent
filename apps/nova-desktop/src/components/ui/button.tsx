import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Button — shadcn's variant API over the class contract this stylesheet already had.
 *
 * Not a rewrite of how buttons look: `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.danger` are the
 * four weights the window was already built on, and they are documented in the stylesheet where the
 * reasoning belongs. What this adds is a *typed* way to ask for one. The window had forty-odd
 * places writing `className="btn ghost"` by hand, which is exactly how a fifth weight gets invented
 * by typo — `btn quiet`, styled by nothing, rendering as an unstyled button nobody notices until it
 * ships.
 *
 * `asChild` is deliberately absent. shadcn uses Radix's `Slot` for it, and every place in this app
 * that needs a trigger to *be* a button already passes `asChild` on the Radix trigger itself and
 * puts a real `<button>` inside — one indirection, not two.
 */
export type ButtonVariant = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "default" | "sm" | "chip";

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: "primary",
  ghost: "ghost",
  danger: "danger",
};

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  default: undefined,
  sm: "tiny",
  chip: "chip",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn("btn", VARIANT_CLASS[variant], SIZE_CLASS[size], className)} {...props} />
  ),
);
Button.displayName = "Button";
