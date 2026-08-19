import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * A hairline, as a component rather than as a border.
 *
 * This layout is built on rules — the whole structure is stated in 1px lines — and a rule that is
 * *between* two things is not the same object as a border *on* one of them: a border belongs to
 * whichever element happens to own it, so removing that element removes the division, and two
 * adjacent bordered elements draw two lines where the design has one.
 *
 * `decorative` (the default) keeps it out of the accessibility tree entirely, which is right for a
 * line that is dividing space. Pass `decorative={false}` only where the line is genuinely the thing
 * separating two groups a screen reader should hear as separate.
 */
export const Separator = forwardRef<
  ElementRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    orientation={orientation}
    decorative={decorative}
    className={cn("rule", `rule-${orientation}`, className)}
    {...props}
  />
));
Separator.displayName = "Separator";
