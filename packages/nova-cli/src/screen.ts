import { computeLayout, type ScreenLayout } from "./layout";

/**
 * Owns the terminal control side of the pinned footer; `layout.ts` owns the math.
 *
 * The mechanism is `DECSTBM` — the scroll-region margin control `tmux`'s own status bar, `less`'s
 * prompt line, and `vim`'s command line all use. Setting a scroll region does not switch to the
 * alternate screen: content that scrolls off the *top* of the region still enters the terminal's
 * real scrollback the same as it always did, which is the whole reason this approach was chosen
 * over a full-screen redraw app — copy-paste and scroll-up over the transcript keep working.
 *
 * Every method here writes raw escape sequences and nothing else; `nova.ts` decides *when* to call
 * them. In particular this class never assumes it owns the cursor between calls — `renderStatus`
 * explicitly saves and restores position around itself so it can be called at any moment (mid-turn,
 * while the input line has a partial word in it) without disturbing what the user is doing.
 */

export type ScreenStream = { write(text: string): boolean; columns?: number; rows?: number };

export class PinnedScreen {
  private layout: ScreenLayout;

  constructor(private readonly stream: ScreenStream) {
    this.layout = computeLayout(stream.rows ?? 24, stream.columns ?? 80);
  }

  get current(): ScreenLayout {
    return this.layout;
  }

  /** Establishes the pinned footer. Call once, after any startup banner has already printed above it. */
  enter(): void {
    this.setRegion();
    this.parkInTranscript();
  }

  /** Recomputes the layout from the stream's live size — call from a `resize` listener. */
  resize(): ScreenLayout {
    this.layout = computeLayout(this.stream.rows ?? 24, this.stream.columns ?? 80);
    this.setRegion();
    this.parkInTranscript();
    return this.layout;
  }

  private setRegion(): void {
    // A region collapsed to zero footer rows (a too-short terminal) gets the full-screen default
    // back — the same sequence `exit()` uses — rather than a degenerate one-row margin.
    this.stream.write(this.layout.footerRows === 0 ? "\x1b[r" : `\x1b[${this.layout.scrollTop};${this.layout.scrollBottom}r`);
  }

  /**
   * Moves the cursor to the bottom of the scroll region.
   *
   * Required before any ordinary transcript write whose *previous* write left the cursor in the
   * footer (most commonly: right after `readline.question()` resolves, which parks the cursor on
   * the input row). Writing a normal `\n`-terminated line from a cursor position outside the margins
   * is undefined behaviour on some terminals — this is what keeps it always defined.
   */
  parkInTranscript(): void {
    if (this.layout.footerRows === 0) return;
    this.stream.write(`\x1b[${this.layout.scrollBottom};1H`);
  }

  /**
   * Redraws the pinned status line in place, then restores the cursor to exactly where it was.
   *
   * Safe to call while the user is mid-keystroke in the input line: save/restore is what makes this
   * a no-op from their point of view rather than a cursor jump they would see and might type into.
   */
  renderStatus(text: string): void {
    if (!this.layout.statusRow) return;
    this.stream.write(`\x1b7\x1b[?25l\x1b[${this.layout.statusRow};1H\x1b[2K${text}\x1b8\x1b[?25h`);
  }

  /** Clears the input row and parks the cursor there. Call immediately before `readline.question()`. */
  positionInput(): void {
    if (!this.layout.inputRow) return;
    this.stream.write(`\x1b[${this.layout.inputRow};1H\x1b[2K`);
  }

  /**
   * Releases the pinned footer and leaves the cursor on a fresh line below everything.
   *
   * Must run before the process actually exits on every path — a scroll region left in place is a
   * margin the user's own shell inherits afterward, which reads as the terminal being broken until
   * they notice and run `reset` or `tput reset` themselves.
   */
  exit(): void {
    this.stream.write("\x1b[r");
    this.stream.write(`\x1b[${this.layout.rows};1H\n`);
  }
}
