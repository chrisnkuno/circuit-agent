import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Dropdown menu — shadcn's anatomy over Radix, for a control that opens a list of *commands*.
 *
 * Distinct from `Popover`, which this app also has, and the difference is not cosmetic: a menu owns
 * the keyboard. Arrow keys move through items, typing jumps to one, Enter takes it, Escape closes
 * and returns focus to the trigger, and the whole thing is announced as a menu rather than as a
 * floating box containing buttons. A popover holding a row of buttons has none of that, which is
 * why the model picker's list and a theme chooser should not be built the same way.
 *
 * `RadioGroup`/`RadioItem` are used rather than plain items wherever the menu expresses a single
 * choice among several, so the current value is announced and not merely ticked in pixels.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, align = "end", sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn("menu", className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn("menu-label", className)} {...props} />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item ref={ref} className={cn("menu-item", className)} {...props} />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

/**
 * One option in a single-choice menu.
 *
 * The tick lives in a fixed-width slot that is present whether or not the item is selected, so the
 * labels form a column instead of shifting sideways as the choice moves. Radix's `ItemIndicator`
 * renders only when selected, hence the slot around it rather than inside it.
 */
export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem ref={ref} className={cn("menu-item", className)} {...props}>
    <span className="menu-mark" aria-hidden="true">
      <DropdownMenuPrimitive.ItemIndicator>—</DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("menu-separator", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

/** The right-hand column of a menu row: a shortcut, a state, a unit. Never the row's meaning. */
export function DropdownMenuShortcut({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return <span className={cn("menu-shortcut", className)} {...props} />;
}
