import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Toggle group — shadcn's anatomy over Radix, for a choice that is always visible.
 *
 * A segmented control rather than a menu, because permission mode is not a setting you go and find:
 * it is the single most consequential piece of state in the window — it decides what Nova may do
 * without asking — and it should read as a position on a scale you can see all of at once.
 *
 * The hand-rolled version this replaces put `role="radio"` on four buttons and managed nothing
 * else. Radix adds roving tabstops (one tab stop for the group, arrows to move within it, which is
 * how a native segmented control behaves), correct `aria-checked` semantics for a single-value
 * group, and — the part that was actually broken before — it will not let the group end up with no
 * value when the current one is clicked again.
 */
export const ToggleGroup = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root ref={ref} className={cn("segmented", className)} {...props} />
));
ToggleGroup.displayName = "ToggleGroup";

export const ToggleGroupItem = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item ref={ref} className={cn("segment", className)} {...props} />
));
ToggleGroupItem.displayName = "ToggleGroupItem";
