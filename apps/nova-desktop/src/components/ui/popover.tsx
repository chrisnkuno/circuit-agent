import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Popover — shadcn's anatomy over Radix, for the menus that hang off a control.
 *
 * Radix does the two things the hand-rolled menu got wrong and one it never had. It portals, so no
 * ancestor's `backdrop-filter` can draw through it — the bug that started this. It positions
 * against the trigger with collision detection, so a menu near the edge of the window flips instead
 * of being clipped, which the hand-measured `getBoundingClientRect` could not do. And it manages
 * focus: focus moves into the panel on open and returns to the trigger on close.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "end", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn("popover", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
