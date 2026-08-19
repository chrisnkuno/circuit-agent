import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentPropsWithoutRef, ElementRef, ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Tooltip — shadcn's anatomy over Radix.
 *
 * Replaces the native `title` attribute, which is the cheapest tooltip and the worst one: it waits
 * about a second before appearing, cannot be styled, never appears for a keyboard user, and is not
 * announced by every screen reader. Radix's opens on hover *and* focus, is described to assistive
 * technology through `aria-describedby`, and is portalled like every other overlay here.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("tooltip", className)} {...props}>
      {props.children}
      <TooltipPrimitive.Arrow className="tooltip-arrow" width={10} height={5} />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";

/**
 * The whole tooltip in one element, since every use in this window is the same shape: a control
 * that needs a sentence. Writing the four Radix parts out at each call site would be ceremony.
 *
 * It carries its own provider. The window mounts one at the root — which is what makes moving
 * between two toolbar buttons show the second immediately — and Radix permits nesting, so this
 * costs nothing there while making the component work anywhere it is put, including a test that
 * renders one control on its own. The alternative is a runtime error thrown from inside Radix
 * ("`Tooltip` must be used within `TooltipProvider`") at the moment someone reuses a component in a
 * new place, which is the worst time to discover a structural requirement.
 */
export function Tooltip(props: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipProvider>
      <TooltipRoot>
        <TooltipTrigger asChild>{props.children}</TooltipTrigger>
        <TooltipContent side={props.side ?? "bottom"}>{props.label}</TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}
