import { clsx, type ClassValue } from "clsx";

/**
 * shadcn's `cn` helper, without `tailwind-merge`.
 *
 * The upstream version exists to resolve conflicts between competing Tailwind utilities — two
 * classes both setting padding, last one winning. This app styles through its own design tokens
 * rather than utilities, so there is nothing to de-duplicate and the merge step would be dead
 * weight in the bundle. Composition is all that is wanted here, which is what clsx does.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
