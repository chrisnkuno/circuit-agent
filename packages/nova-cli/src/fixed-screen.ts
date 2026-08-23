import type { FixedLayoutAction } from "./fixed-layout";

/**
 * The terminal side of the fixed layout: escape sequences, and nothing that can be wrong twice.
 *
 * `fixed-layout.ts` owns every decision about *what* to show. This owns *how*, and it is kept
 * mechanical on purpose — the arithmetic that used to hide bugs is next door and under test, so
 * what remains here is a set of byte sequences that either match the terminal's contract or do not.
 *
 * Three properties are load-bearing:
 *
 * **The alternate screen is entered once and left on every path.** A session that exits — cleanly,
 * by signal, or by crash — while still on the alternate screen leaves the user staring at a shell
 * whose scrollback appears to have vanished. `screen.ts` already learned this about scroll regions;
 * the same discipline applies here, which is why `leave()` is idempotent and safe to call twice.
 *
 * **Every repaint is atomic.** A frame painted row by row into a terminal that is also receiving
 * streamed model output tears visibly. Synchronized output (`?2026`) makes the terminal hold the
 * screen until the frame is complete — a two-sequence wrapper that removes an entire category of
 * flicker.
 *
 * **Mouse reporting is opt-in and reversible.** Turning it on takes drag-to-select away from the
 * user, because the terminal starts routing those events to the application instead. That is a real
 * cost for a wheel, so it is a setting rather than an assumption, and it is turned off the moment
 * the fixed layout is left.
 */

const ESCAPE = "\u001b";
const CSI = `${ESCAPE}[`;

export const ENTER_ALTERNATE_SCREEN = `${CSI}?1049h`;
export const LEAVE_ALTERNATE_SCREEN = `${CSI}?1049l`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
/** SGR mouse reporting: any-event tracking plus the extended coordinate encoding. */
export const ENABLE_MOUSE = `${CSI}?1000h${CSI}?1006h`;
export const DISABLE_MOUSE = `${CSI}?1006l${CSI}?1000l`;
export const BEGIN_SYNC = `${CSI}?2026h`;
export const END_SYNC = `${CSI}?2026l`;

export type FixedStream = { write(text: string): unknown; columns?: number; rows?: number };

export type FixedScreenOptions = {
  /** Wheel scrolling, at the cost of the terminal's own text selection. Off by default. */
  mouse?: boolean;
};

/**
 * Holds the alternate screen for the life of a fixed-layout session.
 *
 * Deliberately tiny and deliberately stateful in exactly one way: whether it is currently entered.
 * Everything else is a function of the frame it is handed.
 */
export class FixedScreen {
  private entered = false;

  constructor(private readonly stream: FixedStream, private readonly options: FixedScreenOptions = {}) {}

  get isEntered(): boolean {
    return this.entered;
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.stream.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${this.options.mouse ? ENABLE_MOUSE : ""}`);
  }

  /**
   * Returns the terminal to how it was found.
   *
   * Idempotent, because it is called from the ordinary exit path *and* from signal handlers *and*
   * from a failure path, and any of those may run after another. A double-leave that writes
   * `?1049l` twice is harmless; a missed leave is a terminal the user has to reset by hand.
   */
  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.stream.write(`${this.options.mouse ? DISABLE_MOUSE : ""}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
  }

  /** Paints one complete frame, atomically. */
  paint(rows: readonly string[]): void {
    this.stream.write(frameSequence(rows));
  }
}

/**
 * The bytes for one frame: home the cursor, write each row cleared to end of line, wrapped in a
 * synchronized-output pair.
 *
 * Rows are cleared individually rather than the screen being erased first. Erasing and redrawing
 * shows a blank screen for one frame on a slow connection, which reads as a flicker on every
 * keystroke; clearing per row overwrites in place and never shows an empty frame.
 */
export function frameSequence(rows: readonly string[]): string {
  const painted = rows.map((row, index) => `${CSI}${index + 1};1H${row}${CSI}K`).join("");
  return `${BEGIN_SYNC}${painted}${END_SYNC}`;
}

export type FixedKeyAction =
  | FixedLayoutAction
  | { kind: "search" }
  | { kind: "searchNext" }
  | { kind: "searchPrev" }
  | { kind: "openPager" }
  | { kind: "leave" };

/**
 * What a key sequence means to the transcript window.
 *
 * Navigation lives on keys the composer has no use for — page, home, end, and the wheel — plus
 * Alt-chords for everything else. That split is not a style choice: this prompt is where free text
 * is typed, so a bare letter would cost every message beginning with that word, and the codebase
 * settled that argument once already for its mnemonic keys. Anything unrecognised returns null and
 * belongs to whoever is reading the composer.
 */
export function decodeFixedKey(sequence: string): FixedKeyAction | null {
  switch (sequence) {
    case `${CSI}5~`:
      return { kind: "pageUp" };
    case `${CSI}6~`:
      return { kind: "pageDown" };
    case `${CSI}H`:
    case `${CSI}1~`:
      return { kind: "top" };
    case `${CSI}F`:
    case `${CSI}4~`:
      return { kind: "bottom" };
    // Alt+Up / Alt+Down: line-at-a-time, without taking the arrow keys from history recall.
    case `${ESCAPE}${CSI}A`:
    case `${CSI}1;3A`:
      return { kind: "up", rows: 1 };
    case `${ESCAPE}${CSI}B`:
    case `${CSI}1;3B`:
      return { kind: "down", rows: 1 };
    case `${ESCAPE}f`:
      return { kind: "search" };
    case `${ESCAPE}n`:
      return { kind: "searchNext" };
    case `${ESCAPE}p`:
      return { kind: "searchPrev" };
    case `${ESCAPE}o`:
      return { kind: "openPager" };
    default:
      return decodeWheel(sequence);
  }
}

/**
 * SGR wheel events, which are the only mouse events worth reading here.
 *
 * Three rows per notch is the convention every terminal pager uses; one row per notch feels broken
 * and a full page per notch overshoots. Button 64 is wheel-up and 65 is wheel-down; anything else —
 * a click, a drag, a release — is deliberately ignored rather than guessed at.
 */
function decodeWheel(sequence: string): FixedKeyAction | null {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(sequence);
  if (!match) return null;
  const button = Number(match[1]);
  if (button === 64) return { kind: "up", rows: 3 };
  if (button === 65) return { kind: "down", rows: 3 };
  return null;
}

/**
 * The status row: where you are, and how to get out.
 *
 * Says what is *not* obvious. Following the tail needs no explanation; being 40% up a transcript
 * with output arriving below does, and so does the fact that the terminal's own scrollback is not
 * what is being scrolled any more.
 */
export function fixedStatusLine(options: { position: string; following: boolean; truncated?: string; columns: number }): string {
  const help = options.following ? "alt+f find · alt+o open in pager" : "end: back to live · alt+f find";
  const left = `${options.position}${options.truncated ? ` · ${options.truncated}` : ""}`;
  // Preserve a visible boundary even when both sides cannot fit. Without this floor, a narrow
  // terminal renders `1/12 for "TypeError"end: back to live`, which reads like corrupted status.
  const room = Math.max(3, options.columns - left.length - help.length);
  return `${left}${" ".repeat(room)}${help}`.slice(0, Math.max(0, options.columns));
}

export type PagerSpawn = (command: string, args: readonly string[], input: string) => Promise<number>;

/**
 * Opens text in the user's pager, and says plainly when it cannot.
 *
 * `$PAGER` first because it is the user's stated preference, then `less -R`, which is the one that
 * understands the colour codes already in the transcript — a pager without `-R` renders every
 * escape sequence as literal `ESC[31m` noise, which looks like Nova corrupted the output.
 *
 * The alternate screen must be left before this runs and re-entered after: two programs both
 * believing they own the screen is how a terminal ends up unusable.
 */
export async function openInPager(
  text: string,
  options: { environment: Record<string, string | undefined>; spawn: PagerSpawn },
): Promise<{ opened: boolean; reason?: string }> {
  const configured = options.environment.PAGER?.trim();
  const [command, ...args] = configured ? configured.split(/\s+/) : ["less", "-R"];
  if (!command) return { opened: false, reason: "No pager is configured. Set PAGER, or install less." };
  try {
    const code = await options.spawn(command, args, text);
    return code === 0 ? { opened: true } : { opened: false, reason: `${command} exited ${code}.` };
  } catch (error) {
    return { opened: false, reason: `Could not run ${command}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
