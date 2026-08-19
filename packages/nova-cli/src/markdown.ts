import type { ColorDepth } from "./banner";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

/**
 * Markdown, rendered for a terminal.
 *
 * Models write markdown whether or not anyone asked them to, so the choice is not "markdown or
 * plain text" — it is "rendered markdown or raw asterisks". Every serious terminal agent renders
 * it, because `**important**` printed literally is worse than no emphasis at all.
 *
 * Everything here is a pure function over a string. The terminal writing lives in `tui.ts`, which
 * is what lets the whole renderer be tested by comparing strings instead of by driving a pty.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * How many columns a string actually occupies.
 *
 * Escape codes are zero-width and must not count, or every wrap calculation drifts by the length
 * of its own colouring. CJK and emoji occupy two columns; treating them as one is what makes a
 * box border sit one character short of its own corner.
 */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const character of text.replace(ANSI, "")) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks sit on the previous cell
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals through Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0x1f300 && code <= 0x1f9ff) // Emoji
  );
}

/** A run of text and the escape code it is painted with. Empty code means unstyled. */
export type StyledToken = { text: string; code: string };

const INLINE_PATTERN = /(?<!\\)(`[^`\n]+`)|(?<!\\)(\*\*[^*\n]+\*\*)|(?<!\\)(__[^_\n]+__)|(?<!\\)(~~[^~\n]+~~)|(?<!\\)(\*[^*\n]+\*)|(?<!\\)(_[^_\n]+_)|(!?\[([^\]\n]+)\]\((https?:\/\/[^\s)\n]+)\))|(<(https?:\/\/[^>\s]+)>)/g;
const unescapeMarkdown = (text: string) => text.replace(/\\([\\`*_[\]{}()#+.!~>-])/g, "$1");

/**
 * Splits a line into styled runs: code spans, bold, italic, and the plain text between them.
 *
 * Code spans are matched first and never re-scanned, so `**` inside backticks stays literal —
 * which matters constantly in a coding agent, where the model quotes shell globs and pointers.
 */
export function parseInline(line: string): StyledToken[] {
  const tokens: StyledToken[] = [];
  let lastIndex = 0;
  INLINE_PATTERN.lastIndex = 0;

  for (let match = INLINE_PATTERN.exec(line); match !== null; match = INLINE_PATTERN.exec(line)) {
    if (match.index > lastIndex) tokens.push({ text: unescapeMarkdown(line.slice(lastIndex, match.index)), code: "" });
    const [whole, code, boldStars, boldUnderscores, strike, italicStars, italicUnderscores, link, linkLabel, linkUrl, autolink, autolinkUrl] = match;
    if (code !== undefined) tokens.push({ text: code.slice(1, -1), code: CYAN });
    else if (boldStars !== undefined) tokens.push({ text: boldStars.slice(2, -2), code: BOLD });
    else if (boldUnderscores !== undefined) tokens.push({ text: boldUnderscores.slice(2, -2), code: BOLD });
    else if (strike !== undefined) tokens.push({ text: strike.slice(2, -2), code: STRIKE });
    else if (italicStars !== undefined) tokens.push({ text: italicStars.slice(1, -1), code: ITALIC });
    else if (italicUnderscores !== undefined) tokens.push({ text: italicUnderscores.slice(1, -1), code: ITALIC });
    else if (link !== undefined) tokens.push({ text: `${link.startsWith("!") ? `image: ${linkLabel}` : linkLabel} (${linkUrl})`, code: CYAN });
    else if (autolink !== undefined) tokens.push({ text: autolinkUrl, code: CYAN });
    lastIndex = match.index + whole.length;
  }
  if (lastIndex < line.length) tokens.push({ text: unescapeMarkdown(line.slice(lastIndex)), code: "" });
  return tokens.filter((token) => token.text.length > 0);
}

function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" || code === "" ? text : `${code}${text}${RESET}`;
}

/**
 * Wraps styled tokens to a width, with a hanging indent.
 *
 * Styling is applied per word rather than per span so that a bold phrase broken across two lines
 * stays bold on both — a span whose opening escape is on the previous line loses its colour the
 * moment anything else resets, which in a scrolling transcript is constantly.
 */
export function wrapTokens(
  tokens: readonly StyledToken[],
  width: number,
  options: { firstPrefix?: string; continuationPrefix?: string; depth: ColorDepth },
): string[] {
  const firstPrefix = options.firstPrefix ?? "";
  const continuationPrefix = options.continuationPrefix ?? "";
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let prefix = firstPrefix;
  let prefixWidth = visibleWidth(firstPrefix);
  // A width that cannot fit one character would loop forever; one column is the floor.
  const limit = Math.max(1, width);

  // Trailing spaces are dropped at every wrap point: they are invisible until someone selects the
  // line to copy it, and then they are noise in whatever they paste it into.
  const flush = () => {
    lines.push(`${prefix}${current}`.replace(/[ \t]+$/, ""));
    current = "";
    currentWidth = 0;
    prefix = continuationPrefix;
    prefixWidth = visibleWidth(continuationPrefix);
  };

  for (const token of tokens) {
    // Splitting on the separator keeps runs of spaces addressable, so indentation inside a
    // sentence is not silently collapsed the way a plain `.split(" ")` would collapse it.
    for (const word of token.text.split(/(\s+)/)) {
      if (word === "") continue;
      const wordWidth = visibleWidth(word);
      if (/^\s+$/.test(word)) {
        // Trailing whitespace at a wrap point is dropped rather than pushed onto the next line.
        if (currentWidth > 0 && prefixWidth + currentWidth + wordWidth <= limit) {
          current += word;
          currentWidth += wordWidth;
        }
        continue;
      }
      if (currentWidth > 0 && prefixWidth + currentWidth + wordWidth > limit) flush();
      if (prefixWidth + wordWidth > limit) {
        // A single word longer than the terminal: break it rather than let the terminal wrap it,
        // so the hanging indent is still honoured on every row it occupies.
        //
        // Every iteration consumes at least one character and stops once nothing is left. The
        // earlier form compared against `limit - prefixWidth`, which is negative when the prefix
        // is wider than the terminal — a condition no remaining width can ever satisfy, so it
        // flushed empty lines until the array itself overflowed.
        let remaining = word;
        while (remaining.length > 0) {
          const available = Math.max(1, limit - prefixWidth - currentWidth);
          if (visibleWidth(remaining) <= available) break;
          const head = [...remaining].slice(0, available).join("");
          current += paint(head, token.code, options.depth);
          remaining = [...remaining].slice(available).join("");
          flush();
        }
        if (remaining.length > 0) {
          current += paint(remaining, token.code, options.depth);
          currentWidth += visibleWidth(remaining);
        }
        continue;
      }
      current += paint(word, token.code, options.depth);
      currentWidth += wordWidth;
    }
  }
  if (current !== "" || lines.length === 0) lines.push(`${prefix}${current}`.replace(/[ \t]+$/, ""));
  return lines;
}

/** Fence state carried between lines, since a code block spans many of them. */
export type MarkdownState = { inFence: boolean; fenceLanguage: string };

export function newMarkdownState(): MarkdownState {
  return { inFence: false, fenceLanguage: "" };
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const FENCE = /^\s*```(.*)$/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

function tableCells(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = trimmed.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function fitCell(text: string, width: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  let result = "";
  for (const character of text) {
    if (visibleWidth(result + character) > width) {
          while (visibleWidth(result) > Math.max(0, width - visibleWidth(glyphs.ellipsis))) result = [...result].slice(0, -1).join("");
      result += glyphs.ellipsis;
      return result + " ".repeat(Math.max(0, width - visibleWidth(result)));
    }
    result += character;
  }
  return result + " ".repeat(Math.max(0, width - visibleWidth(result)));
}

function renderTableLine(cells: string[], separator: boolean, width: number, depth: ColorDepth, glyphs: GlyphSet): string {
  const cellWidth = Math.max(3, Math.floor((Math.max(width, 12) - cells.length - 1) / cells.length));
  if (separator) return paint(`${glyphs.boxTeeLeft}${cells.map(() => glyphs.boxHorizontal.repeat(cellWidth)).join(glyphs.boxCross)}${glyphs.boxTeeRight}`, DIM, depth);
  const contentWidth = Math.max(1, cellWidth - 2);
  const rendered = cells.map((cell) => fitCell(parseInline(cell).map((token) => token.text).join(""), contentWidth, glyphs));
  return `${glyphs.boxVertical}${rendered.map((cell) => ` ${cell} `).join(glyphs.boxVertical)}${glyphs.boxVertical}`;
}

/**
 * Renders one source line into the physical terminal lines it occupies.
 *
 * Returns an array because a single markdown line is usually several terminal rows, and the
 * caller needs to know how many were produced to keep its own cursor arithmetic honest.
 */
export function renderMarkdownLine(
  line: string,
  state: MarkdownState,
  options: { width: number; depth: ColorDepth; glyphs?: GlyphSet },
): string[] {
  const { width, depth } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;

  const fence = FENCE.exec(line);
  if (fence) {
    // Both rules are drawn to the same length, which is the difference between a block that reads
    // as a deliberate bracket and one that reads as a box someone failed to close. It is an open
    // bracket on purpose — streamed markdown arrives a line at a time, so the right edge would have
    // to be guessed before the code that determines it exists — but "open on the right" and
    // "unfinished" look identical when the top rule stops after the label and the bottom is a stub.
    const ruleWidth = Math.max(4, Math.min(width - 4, 40));
    if (state.inFence) {
      state.inFence = false;
      state.fenceLanguage = "";
      return [paint(`  ${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(ruleWidth)}`, DIM, depth)];
    }
    state.inFence = true;
    state.fenceLanguage = fence[1].trim();
    const label = state.fenceLanguage ? ` ${state.fenceLanguage} ` : "";
    const drawn = 1 + visibleWidth(label);
    return [paint(`  ${glyphs.boxTopLeft}${glyphs.boxHorizontal}${label}${glyphs.boxHorizontal.repeat(Math.max(0, ruleWidth - drawn))}`, DIM, depth)];
  }

  if (state.inFence) {
    // Code is never re-wrapped: a broken line of code is a lie about the file it came from, so it
    // is left to the terminal and marked with a gutter that makes the block's extent obvious.
    return [`${paint(`  ${glyphs.boxVertical} `, DIM, depth)}${paint(line, GREEN, depth)}`];
  }

  const table = tableCells(line);
  if (table) {
    const separator = table.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
    return [renderTableLine(table, separator, width, depth, glyphs)];
  }

  if (RULE.test(line) && line.trim().length > 0) {
    return [paint("  " + glyphs.boxHorizontal.repeat(Math.max(4, Math.min(width - 4, 40))), DIM, depth)];
  }

  const heading = HEADING.exec(line);
  if (heading) {
    const level = heading[1].length;
    const code = level <= 2 ? `${BOLD}${CYAN}` : BOLD;
    // Parsed for inline markers so a heading like "## What `hello.py` does" loses its backticks,
    // then painted uniformly: a code span inside an already-coloured heading reads as a mistake.
    const tokens = parseInline(heading[2]).map((token) => ({ text: token.text, code }));
    return wrapTokens(tokens, width, { depth });
  }

  const task = TASK.exec(line);
  if (task) {
    return wrapTokens(parseInline(task[3]), width, {
      firstPrefix: `${task[1]}${paint(task[2].trim() ? glyphs.checkboxDone : glyphs.checkbox, task[2].trim() ? GREEN : BLUE, depth)} `,
      continuationPrefix: `${task[1]}  `,
      depth,
    });
  }

  const bullet = BULLET.exec(line);
  if (bullet) {
    const indent = bullet[1];
    return wrapTokens(parseInline(bullet[3]), width, {
      firstPrefix: `${indent}${paint(glyphs.bullet, BLUE, depth)} `,
      continuationPrefix: `${indent}  `,
      depth,
    });
  }

  const numbered = NUMBERED.exec(line);
  if (numbered) {
    const indent = numbered[1];
    const marker = numbered[2];
    return wrapTokens(parseInline(numbered[3]), width, {
      firstPrefix: `${indent}${paint(marker, BLUE, depth)} `,
      continuationPrefix: `${indent}${" ".repeat(marker.length + 1)}`,
      depth,
    });
  }

  const quote = BLOCKQUOTE.exec(line);
  if (quote) {
    return wrapTokens([{ text: quote[1], code: DIM }], width, {
      firstPrefix: paint(`${glyphs.boxVertical} `, YELLOW, depth),
      continuationPrefix: paint(`${glyphs.boxVertical} `, YELLOW, depth),
      depth,
    });
  }

  if (line.trim() === "") return [""];
  return wrapTokens(parseInline(line), width, { depth });
}

/** Renders a whole markdown document, for text that is already complete when it arrives. */
export function renderMarkdown(text: string, options: { width: number; depth: ColorDepth; glyphs?: GlyphSet }): string {
  const state = newMarkdownState();
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const rendered = text
    .split("\n")
    .flatMap((line) => renderMarkdownLine(line, state, options))
  if (state.inFence) rendered.push(paint(`  ${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(4)}`, DIM, options.depth));
  return rendered.join("\n");
}
