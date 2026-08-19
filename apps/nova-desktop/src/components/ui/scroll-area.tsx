import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "./cn";

/**
 * Scroll area — shadcn's anatomy over Radix, for the surfaces whose scrollbar is part of the design.
 *
 * Native overlay scrollbars are inconsistent across the three platforms this app ships on: a
 * permanent 15px grey trough on Windows, an overlay that fades on macOS, something else again on a
 * Linux webview. In a layout whose structure is stated in hairlines, a fat platform trough is the
 * widest, loudest vertical line on the screen and it lands right beside the ones that mean
 * something. This replaces it with a 2px rule that appears while scrolling.
 *
 * `viewportRef` is threaded through because scroll *position* is application state here — the
 * transcript follows new output only while the reader is already at the bottom — and Radix's
 * viewport is the element that actually scrolls, not the root.
 */
export const ScrollArea = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportClassName?: string;
    onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  }
>(({ className, children, viewportRef, viewportClassName, onViewportScroll, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn("scroll-area", className)} {...props}>
    <ScrollAreaPrimitive.Viewport
      ref={viewportRef}
      className={cn("scroll-viewport", viewportClassName)}
      onScroll={onViewportScroll}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = "ScrollArea";

export const ScrollBar = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn("scroll-bar", `scroll-bar-${orientation}`, className)}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="scroll-thumb" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = "ScrollBar";
