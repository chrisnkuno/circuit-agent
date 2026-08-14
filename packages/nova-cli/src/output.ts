/**
 * Where a line goes, decided once instead of at every write.
 *
 * Nova's renderer grew up calling `process.stdout.write` directly — a hundred and sixty times, from
 * every corner of the REPL. That is fine while exactly one thing is talking, and it is the reason
 * `tabs.ts` had to describe itself as *sequential*: a second piece of work producing output would
 * have no way to produce it anywhere except on top of the first one's. One cursor, one writer.
 *
 * This module is the indirection that removes that limit. A sink is anything a line can be written
 * to; a tab owns one; the router says which sink the shared renderer is currently addressing. Work
 * that is not in front writes to its own sink and accumulates there, and comes back with its
 * transcript intact rather than with the hole that "it printed while you were elsewhere" leaves.
 *
 * Two decisions are load-bearing:
 *
 * - **The terminal sink resolves `process.stdout.write` at call time, never a bound copy.** Headless
 *   mode (`--json`) claims stdout for JSONL by *replacing* that method, deliberately, so the
 *   guarantee holds for output this codebase does not own. Capturing the function here would route
 *   around that choke point and put human prose back into a machine-readable stream.
 * - **A sink logs whole lines, not writes.** Assistant text arrives as deltas with no newlines in
 *   them, so counting writes would count nothing meaningful and replaying them would reproduce
 *   half-lines. Text is joined and committed only when a newline actually arrives.
 */

/** The narrow slice of `NodeJS.WriteStream` the renderers actually use. */
export type OutputStream = {
  write(text: string): void;
  readonly columns?: number;
  readonly rows?: number;
};

/**
 * The real terminal.
 *
 * `columns`/`rows` are getters rather than captured numbers because a terminal is resizable and a
 * snapshot taken at construction would be wrong for the rest of the session.
 */
export const terminalStream: OutputStream = {
  write(text: string): void {
    process.stdout.write(text);
  },
  get columns(): number | undefined {
    return process.stdout.columns;
  },
  get rows(): number | undefined {
    return process.stdout.rows;
  },
};

/** How many lines a background tab keeps before the oldest start falling off the back. */
export const DEFAULT_SCROLLBACK_LINES = 5_000;

/**
 * A bounded record of what was written, in lines.
 *
 * Bounded on purpose: a tab left running a build in the background would otherwise hold the whole
 * build log in memory for as long as the session lives, and the value of a scrollback drops sharply
 * with age. What is dropped is *counted*, so a replay can say so rather than silently presenting a
 * truncated history as if it were the whole of it.
 */
export class LineLog {
  private readonly committed: string[] = [];
  /** Text written since the last newline — a line still being formed, not yet part of the log. */
  private partial = "";
  private droppedLines = 0;

  constructor(private readonly limit: number = DEFAULT_SCROLLBACK_LINES) {}

  write(text: string): void {
    if (text === "") return;
    const parts = (this.partial + text).split("\n");
    // The last element is whatever followed the final newline: the empty string when the write
    // ended cleanly, otherwise the start of a line still being built.
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.commit(line);
  }

  private commit(line: string): void {
    this.committed.push(line);
    if (this.committed.length > this.limit) {
      this.committed.shift();
      this.droppedLines += 1;
    }
  }

  /** Commits a half-formed line, for the moment a tab is left and its last line should still count. */
  flush(): void {
    if (this.partial === "") return;
    this.commit(this.partial);
    this.partial = "";
  }

  get lines(): readonly string[] {
    return this.committed;
  }

  get pending(): string {
    return this.partial;
  }

  get size(): number {
    return this.committed.length;
  }

  get dropped(): number {
    return this.droppedLines;
  }

  /** The most recent `count` lines, oldest first — what a replay shows. */
  tail(count: number): string[] {
    return count <= 0 ? [] : this.committed.slice(Math.max(0, this.committed.length - count));
  }

  clear(): void {
    this.committed.length = 0;
    this.partial = "";
    this.droppedLines = 0;
  }
}

/**
 * One tab's output.
 *
 * Always records; forwards to the terminal only while this tab is the one being watched. That pair
 * is the whole feature: a tab in front behaves exactly as the CLI always has (the bytes reaching
 * the terminal are unchanged, which is why the existing transcript tests still hold), and a tab
 * that is not in front stops competing for the cursor without losing anything it had to say.
 */
export class TabSink implements OutputStream {
  readonly log: LineLog;
  private live: boolean;

  constructor(
    private readonly downstream: OutputStream = terminalStream,
    options: { live?: boolean; limit?: number } = {},
  ) {
    this.live = options.live ?? false;
    this.log = new LineLog(options.limit);
  }

  get isLive(): boolean {
    return this.live;
  }

  /**
   * Brings this sink to the front, or sends it to the back.
   *
   * Going to the back flushes a half-written line: nothing further will be appended to it for now,
   * and leaving it uncommitted would drop it from a replay of everything that happened.
   */
  setLive(live: boolean): void {
    if (!live) this.log.flush();
    this.live = live;
  }

  write(text: string): void {
    this.log.write(text);
    if (this.live) this.downstream.write(text);
  }

  get columns(): number | undefined {
    return this.downstream.columns;
  }

  get rows(): number | undefined {
    return this.downstream.rows;
  }
}

/**
 * The address the renderer writes to.
 *
 * A single mutable target rather than a handle threaded through every call site: the renderer is
 * already module state (`markdown`, `statusBar`, `glyphs` — see `nova.ts`), because there is one
 * screen, and a renderer told where to write at every call site is one that eventually gets told
 * wrong somewhere. Switching tabs re-points this once.
 */
export class OutputRouter implements OutputStream {
  constructor(private target: OutputStream = terminalStream) {}

  get current(): OutputStream {
    return this.target;
  }

  route(target: OutputStream): void {
    this.target = target;
  }

  write(text: string): void {
    this.target.write(text);
  }

  get columns(): number | undefined {
    return this.target.columns;
  }

  get rows(): number | undefined {
    return this.target.rows;
  }
}

/**
 * What a tab missed, ready to print when it comes back.
 *
 * Returns lines rather than a joined string so the caller decides the separator and can prefix each
 * one; `dropped` is reported so a replay can admit to being partial instead of implying the tab
 * began where the replay does.
 */
export function replayLines(log: LineLog, count: number): { lines: string[]; dropped: number; omitted: number } {
  const lines = log.tail(count);
  return { lines, dropped: log.dropped, omitted: Math.max(0, log.size - lines.length) };
}
