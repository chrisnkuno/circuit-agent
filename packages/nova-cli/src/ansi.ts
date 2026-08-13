import type { ColorDepth } from "./banner";

/**
 * The escape codes, and the one function that decides whether to emit them.
 *
 * `tui.ts` and `markdown.ts` each grew their own private copy of this constant block and their own
 * `paint`, which is how a renderer ends up honouring `NO_COLOR` in one file and not in the next.
 * New rendering modules take these instead.
 */

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const UNDERLINE = "\x1b[4m";
export const REVERSE = "\x1b[7m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const GREY = "\x1b[90m";

/** Paints `text` unless the destination cannot show colour, in which case the code is dropped. */
export function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" || code === "" ? text : `${code}${text}${RESET}`;
}

/** Two codes at once — `bold cyan` and friends, without nesting two resets inside each other. */
export function paintAll(text: string, codes: readonly string[], depth: ColorDepth): string {
  return depth === "none" || codes.length === 0 ? text : `${codes.join("")}${text}${RESET}`;
}
