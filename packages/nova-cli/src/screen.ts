import { computeLayout, type ScreenLayout } from "./layout";
import { SpringAnimator } from "./tui";

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

export type PinnedScreenOptions = {
  /**
   * Whether to hold the scroll region for the whole session.
   *
   * Held, the footer stays on a fixed row — and the terminal saves nothing that scrolls past the
   * top, because scrollback only receives lines when the scrolling region is the entire screen.
   * That is a real cost and it is now a choice: unheld, the region is set only for the moments the
   * dropdown needs reserved rows (while the user is typing, when nothing is being printed) and
   * released immediately after, so every line of actual output scrolls into real history.
   */
  holdRegion?: boolean;
  /**
   * Resizes the dropdown over a few frames instead of jumping straight to the new row count.
   *
   * Off by default — every test in `screen.test.ts` asserts an exact, synchronous escape-sequence
   * output, which an animation running on a timer would break. `nova.ts` turns it on for a real
   * interactive session, where a resize the user actually watches happen is worth a spring instead
   * of a snap, now that the snap itself is correct (see the shrink branch below).
   */
  animate?: boolean;
};

export class PinnedScreen {
  private layout: ScreenLayout;
  /** Transcript rows currently lent to the suggestion dropdown. */
  private suggestionRows = 0;
  private readonly holdRegion: boolean;
  /** True while a region is set — either held for the session, or borrowed by the dropdown. */
  private regionActive = false;
  private readonly animate: boolean;
  /** The rows most recently asked for — read by the animator's own ticks, which run after the call that started them returns. */
  private suggestionLines: readonly string[] = [];
  private rowsAnimator: SpringAnimator | undefined;

  constructor(private readonly stream: ScreenStream, options: PinnedScreenOptions = {}) {
    this.layout = computeLayout(stream.rows ?? 24, stream.columns ?? 80);
    this.holdRegion = options.holdRegion ?? true;
    this.animate = options.animate ?? false;
  }

  /** Whether this screen owns a pinned row to draw a status line on. */
  get pinned(): boolean {
    return this.holdRegion;
  }

  get current(): ScreenLayout {
    return this.layout;
  }

  /** Establishes the pinned footer. Call once, after any startup banner has already printed above it. */
  enter(): void {
    if (!this.holdRegion) return;
    this.setRegion();
    this.parkInTranscript();
  }

  /** Recomputes the layout from the stream's live size — call from a `resize` listener. */
  resize(): ScreenLayout {
    // Rows reserved against the old geometry describe nothing about the new one, and keeping the
    // count would shrink the region by rows the dropdown no longer occupies.
    this.suggestionRows = 0;
    // A spring mid-flight is animating toward a row count and a scroll region that both just
    // stopped existing; anything it ticks next would paint against stale geometry.
    this.rowsAnimator?.stop();
    this.rowsAnimator = undefined;
    this.layout = computeLayout(this.stream.rows ?? 24, this.stream.columns ?? 80);
    if (this.holdRegion) {
      this.setRegion();
      this.parkInTranscript();
    } else if (this.regionActive) {
      // A borrowed region describes rows that the new geometry has moved; give it straight back
      // rather than leaving the terminal clipped to a rectangle that no longer means anything.
      this.releaseRegion();
    }
    return this.layout;
  }

  private setRegion(): void {
    // A region collapsed to zero footer rows (a too-short terminal) gets the full-screen default
    // back — the same sequence `exit()` uses — rather than a degenerate one-row margin.
    this.stream.write(this.layout.footerRows === 0 ? "\x1b[r" : `\x1b[${this.layout.scrollTop};${this.layout.scrollBottom}r`);
    this.regionActive = this.layout.footerRows !== 0;
  }

  /** Hands the whole screen back, so scrolled-off lines reach the terminal's scrollback again. */
  private releaseRegion(): void {
    if (!this.regionActive) return;
    this.stream.write("\x1b[r");
    this.regionActive = false;
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
    if (!this.holdRegion || this.layout.footerRows === 0) return;
    this.stream.write(`\x1b[${this.layout.scrollBottom};1H`);
  }

  /**
   * Redraws the pinned status line in place, then restores the cursor to exactly where it was.
   *
   * Safe to call while the user is mid-keystroke in the input line: save/restore is what makes this
   * a no-op from their point of view rather than a cursor jump they would see and might type into.
   */
  renderStatus(text: string): void {
    // Without a held region these rows are ordinary transcript; drawing on them would overwrite
    // whatever had scrolled into them.
    if (!this.holdRegion || !this.layout.statusRow) return;
    this.stream.write(`\x1b7\x1b[?25l\x1b[${this.layout.statusRow};1H\x1b[2K${text}\x1b8\x1b[?25h`);
  }

  /**
   * Draws the input bar's closing border, then restores the cursor.
   *
   * The mirror of `renderStatus` — the top border carries the status text, this one closes the box
   * — and it saves and restores position for the same reason: the row is *below* the input line, so
   * reaching it means leaving wherever the user is typing and having to come back exactly.
   */
  renderPromptBottom(text: string): void {
    if (!this.holdRegion || !this.layout.promptBottomRow) return;
    this.stream.write(`\x1b7\x1b[?25l\x1b[${this.layout.promptBottomRow};1H\x1b[2K${text}\x1b8\x1b[?25h`);
  }

  /** Clears the input row and parks the cursor there. Call immediately before `readline.question()`. */
  positionInput(): void {
    if (!this.holdRegion || !this.layout.inputRow) return;
    this.stream.write(`\x1b[${this.layout.inputRow};1H\x1b[2K`);
  }

  /**
   * The suggestion dropdown, drawn upward from just above the footer.
   *
   * Non-modal by construction, which is the whole design. The obvious way to build a dropdown is to
   * take the keyboard, read keys and paint frames — but every slash command is *typed*, so a menu
   * that opens on "/" then owns the keyboard swallows the rest of `/model haiku`, and history,
   * Ctrl-A/E and @-completion all go dead while it is up. Painting into reserved rows instead means
   * readline never stops being in charge of a single keystroke: the list is something the user
   * reads, not something they are trapped in.
   *
   * Rows are taken by scrolling the transcript up rather than by drawing over it, so the lines that
   * make way move into real scrollback instead of being destroyed. They are reserved once and then
   * reused: re-scrolling per keystroke would walk the transcript upward as the user types.
   */
  renderSuggestions(lines: readonly string[]): void {
    if (this.layout.footerRows === 0) return;
    const wanted = Math.min(lines.length, this.maxSuggestionRows());
    this.suggestionLines = lines;
    if (wanted === 0) { this.clearSuggestions(); return; }

    if (!this.animate) { this.applyRows(wanted); return; }

    // Redirected, not restarted: a keystroke arriving mid-resize should change where the spring is
    // headed, not snap it back to a standstill and make the animation start over.
    if (!this.rowsAnimator) {
      this.rowsAnimator = new SpringAnimator(this.suggestionRows, (value) => this.applyRows(Math.round(value)));
    }
    this.rowsAnimator.retarget(wanted);
  }

  /**
   * Jumps — or, mid-animation, steps — the reserved rows to exactly `target`, then repaints the
   * (possibly unchanged) current content into whatever rows now exist. Content is always painted
   * from `this.suggestionLines`, the *final* target lines: growing an animation therefore reveals
   * real suggestions one row at a time rather than interpolating fake ones, and shrinking clears the
   * rows no longer wanted while the ones still on screen keep showing the correct text throughout.
   */
  private applyRows(target: number): void {
    const lines = this.suggestionLines;
    if (target > this.suggestionRows) {
      const extra = target - this.suggestionRows;
      // Borrowed, not held: without --pin there is no standing region, so one is set for exactly
      // as long as the dropdown is on screen. Nothing is printed to the transcript while the user
      // is typing a command, so no line can be lost to it — and `clearSuggestions` gives it back.
      this.regionActive = true;
      // Widened back to the full transcript first: the rows being freed are the ones a previous
      // reservation already cut out of the region, and `SU` only scrolls within the current margins.
      this.stream.write(`\x1b7\x1b[${this.layout.scrollTop};${this.layout.scrollBottom}r`);
      this.stream.write(`\x1b[${extra}S`);
      this.suggestionRows = target;
      this.stream.write(`\x1b[${this.layout.scrollTop};${this.transcriptBottom()}r\x1b8`);
    } else if (target < this.suggestionRows) {
      // Fewer rows than a moment ago (typing narrowed the matches, a history/completion redraw
      // changed the line, or an animation is mid-shrink) — clear the rows no longer wanted and widen
      // the region's bottom margin back to reclaim them. Without this the dropdown only ever grew:
      // it shrank the row count it drew into but never gave the freed rows back, leaving blank
      // reserved space behind — a "big gap" under a suggestion list that had just gotten shorter.
      const top = this.transcriptBottom() + 1;
      this.stream.write("\x1b7\x1b[?25l");
      for (let offset = target; offset < this.suggestionRows; offset += 1) this.stream.write(`\x1b[${top + offset};1H\x1b[2K`);
      this.suggestionRows = target;
      this.stream.write(`\x1b[${this.layout.scrollTop};${this.transcriptBottom()}r\x1b8\x1b[?25h`);
    }

    const top = this.transcriptBottom() + 1;
    this.stream.write("\x1b7\x1b[?25l");
    for (let offset = 0; offset < this.suggestionRows; offset += 1) {
      this.stream.write(`\x1b[${top + offset};1H\x1b[2K${lines[offset] ?? ""}`);
    }
    this.stream.write("\x1b8\x1b[?25h");
  }

  /** Takes the reserved rows back. The blank gap left behind fills with the next transcript write. */
  clearSuggestions(): void {
    this.rowsAnimator?.stop();
    if (this.suggestionRows === 0) return;
    const top = this.transcriptBottom() + 1;
    this.stream.write("\x1b7\x1b[?25l");
    for (let offset = 0; offset < this.suggestionRows; offset += 1) this.stream.write(`\x1b[${top + offset};1H\x1b[2K`);
    this.suggestionRows = 0;
    this.stream.write(this.holdRegion
      ? `\x1b[${this.layout.scrollTop};${this.layout.scrollBottom}r\x1b8\x1b[?25h`
      : "\x1b[r\x1b8\x1b[?25h");
    if (!this.holdRegion) this.regionActive = false;
  }

  /** The bottom of the transcript right now: the layout's, less whatever the dropdown has reserved. */
  private transcriptBottom(): number {
    return this.layout.scrollBottom - this.suggestionRows;
  }

  /**
   * Never so many rows that the transcript stops being one.
   *
   * A dropdown that can eat the whole screen turns a scrolling log into a menu with a log-shaped
   * hole; `MIN_TRANSCRIPT_ROWS` is the floor `computeLayout` already keeps, and this respects it.
   */
  private maxSuggestionRows(): number {
    return Math.max(0, Math.min(8, this.layout.scrollBottom - 3));
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
