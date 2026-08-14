/**
 * The screen, as rows and columns rather than a scrolling log.
 *
 * Nova's transcript has always been an append-only scroll — real terminal scrollback, real
 * copy-paste, nothing redrawn behind the cursor's back. That stays true here: this only carves a
 * fixed-height footer off the *bottom* of the screen (a status line, an input line) via the
 * terminal's own scroll-region margins, so the transcript above it keeps scrolling — and keeps
 * entering real scrollback — exactly as before. Nothing here is an alternate-screen app; it is the
 * same log with somewhere fixed to type, the way `tmux`'s status bar or `less`'s prompt line work.
 *
 * Every number here is a pure function of `(rows, columns)`, checked without a terminal — the
 * terminal-control side effects live in `screen.ts`, which calls this and does the writing.
 */

export const GOLDEN_RATIO = 1.618033988749895;

/**
 * The comfortable reading measure prose is capped at, on a wide terminal.
 *
 * A line of text spanning a 300-column ultrawide window is harder to read, not easier — the
 * typographic case for a bounded measure is old and well established. The cap itself is derived
 * rather than picked: `80` is the terminal-width fallback this codebase already uses everywhere a
 * real size isn't known (`process.stdout.columns ?? 80`), so scaling *that* by the golden ratio —
 * the same proportion the product already applies to its other deliberate space split, the web
 * terminal's 1.618:1 panel layout — gives a generous-but-bounded measure tied to an existing
 * convention instead of a second unrelated magic number invented for this alone.
 */
const MAX_CONTENT_WIDTH = Math.round(80 * GOLDEN_RATIO);

/**
 * A titled top border, an input line, a closing border — the three rows the chat-style input bar
 * occupies. The top border is not chrome spent on decoration: it is the status line, wearing the
 * box's own edge, so the bar costs one row more than a bare status-plus-input footer rather than
 * three rows more.
 */
const FOOTER_ROWS = 3;

/** However short the terminal, the scrollable transcript keeps at least this many rows. */
const MIN_TRANSCRIPT_ROWS = 3;

export type ScreenLayout = {
  rows: number;
  columns: number;
  /** 1-indexed, inclusive: the scrollable transcript region passed to the terminal's margin control. */
  scrollTop: number;
  scrollBottom: number;
  /** 0 on a terminal too short to spare a footer at all — the caller falls back to plain scrolling. */
  footerRows: 0 | 1 | 2 | 3;
  /**
   * Row for the input bar's top border, which is also where the status line is drawn — the border
   * carries the status text as its title. Undefined when the terminal can't spare the row.
   */
  statusRow: number | undefined;
  /**
   * Row for the input line. This is the one footer element that matters — undefined only when the
   * terminal is too short to reserve any fixed row at all, the same last-resort a chat UI has none
   * of on a one-line terminal.
   */
  inputRow: number | undefined;
  /**
   * Row for the input bar's closing border. The first thing given up on a short terminal: a box
   * missing its bottom edge still reads as a box, and the row buys back transcript.
   */
  promptBottomRow: number | undefined;
  /** Wrapping width for prose: full width up to a comfortable measure, then capped by golden ratio. */
  contentWidth: number;
};

export function computeLayout(rows: number, columns: number): ScreenLayout {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeColumns = Math.max(1, Math.floor(columns));

  // Give up the closing border first, then the status row, and the input row last — the same
  // "least essential detail goes first" rule `formatStatusLine` already applies within one line,
  // one level up: a chat UI with no place to type isn't a degraded chat UI, it's a different
  // program, while one drawn with three sides of a box instead of four is still recognisably it.
  const footerRows = Math.min(FOOTER_ROWS, Math.max(0, safeRows - MIN_TRANSCRIPT_ROWS)) as 0 | 1 | 2 | 3;
  const scrollBottom = safeRows - footerRows;

  return {
    rows: safeRows,
    columns: safeColumns,
    scrollTop: 1,
    scrollBottom,
    footerRows,
    statusRow: footerRows >= 2 ? scrollBottom + 1 : undefined,
    // With a top border the input sits under it; with only one row to spare, that row *is* the input.
    inputRow: footerRows >= 2 ? scrollBottom + 2 : footerRows === 1 ? scrollBottom + 1 : undefined,
    promptBottomRow: footerRows >= 3 ? scrollBottom + 3 : undefined,
    contentWidth: Math.min(safeColumns, MAX_CONTENT_WIDTH),
  };
}
