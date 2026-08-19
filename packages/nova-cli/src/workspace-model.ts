import type { Palette } from "./theme";
import type { TabView } from "./tabs";
import { StreamSeries, waveLine } from "./charts";
import { visibleWidth } from "./markdown";
import { clip } from "./sections";
import { scrollIndicator, scrollPercent } from "./tui";

/**
 * What the control panel is looking at, as data.
 *
 * Deliberately a plain snapshot with no behaviour and no imports from the framework that draws it.
 * Two reasons, and the second is the important one:
 *
 * - Every decision the panel makes — which tab is selected, how far a pane is scrolled, what a key
 *   does — is a pure function of this and testable by comparing values, rather than by rendering a
 *   terminal and reading pixels back.
 * - It is the seam. The screen that draws this is TermUI today; if that changes, or if a second
 *   surface is added, the thing being drawn does not move. Nova's transcript renderer already
 *   works this way (`sections.ts` returns strings, `nova.ts` decides where they go), and this is
 *   the same separation one layer up.
 */

export type WorkspacePane = {
  kind: "tab" | "job";
  /** Tab id as a number, job id as its string — unique within its kind. */
  key: string;
  title: string;
  subtitle: string;
  status: "idle" | "running" | "failed" | "done";
  /** Everything the pane has to show, oldest first. */
  lines: readonly string[];
  /** How many lines fell off the front of the record. */
  dropped: number;
  /**
   * Recent output rate, oldest sample first, for the header's activity line.
   *
   * A pane's status says running or idle; this says *how* it is running — a steady stream, a burst
   * and then silence, or nothing for the last minute. With several panes open that is the
   * difference between "which of these is working" and "which of these is stuck", which the status
   * mark alone cannot answer.
   */
  activity?: readonly number[];
};

export type WorkspaceSnapshot = {
  panes: readonly WorkspacePane[];
  /** Index into `panes`. Out of range is corrected on read, never stored. */
  selected: number;
  /** Rows from the bottom of the selected pane; 0 means pinned to the newest line. */
  scroll: number;
  palette: Palette;
  columns: number;
  rows: number;
};

export type WorkspaceAction =
  | { kind: "select"; index: number }
  | { kind: "cycle"; step: number }
  | { kind: "scroll"; lines: number }
  | { kind: "bottom" }
  | { kind: "top" }
  | { kind: "exit" }
  | { kind: "focus" }
  | { kind: "none" };

/** Rows of a pane's body, once the frame's chrome has taken its share. */
export function paneHeight(rows: number): number {
  // One row for the tab bar, one for the pane header, one for the footer legend, one for the rule
  // under the bar. Floored at 1: a terminal too short to show anything still must not compute a
  // negative window and slice a list backwards.
  return Math.max(1, rows - 4);
}

/** The pane in focus, with the index corrected rather than trusted. */
export function selectedPane(snapshot: WorkspaceSnapshot): WorkspacePane | undefined {
  if (snapshot.panes.length === 0) return undefined;
  const index = Math.max(0, Math.min(snapshot.selected, snapshot.panes.length - 1));
  return snapshot.panes[index];
}

/**
 * The slice of a pane that is on screen.
 *
 * Scroll counts *from the bottom*, because the newest line is where attention belongs and a pane
 * that grows while you are reading it must not slide the text you are looking at. At `scroll: 0`
 * the newest line is the last row; scrolling up moves backward through history and the newest line
 * leaves the bottom, which is exactly the behaviour that makes "am I at the live edge?" answerable.
 */
export function visibleLines(pane: WorkspacePane, height: number, scroll: number): string[] {
  const clamped = Math.max(0, Math.min(scroll, Math.max(0, pane.lines.length - height)));
  const end = pane.lines.length - clamped;
  return pane.lines.slice(Math.max(0, end - height), end);
}

/** True when the pane is showing its newest line — what the "live" marker means. */
export function atLiveEdge(pane: WorkspacePane, height: number, scroll: number): boolean {
  return Math.min(scroll, Math.max(0, pane.lines.length - height)) === 0;
}

/**
 * What a key does.
 *
 * Numbers select, arrows and Tab move, `g`/`G` jump to the ends, `q` and Escape leave. Both the
 * arrow keys and `j`/`k` scroll, because half the people who will use this have muscle memory from
 * a pager and the other half do not, and supporting one of them is a choice with no upside.
 */
export function keyToAction(key: { name?: string; ctrl?: boolean; shift?: boolean }, character?: string): WorkspaceAction {
  const name = key.name ?? "";
  // Both spellings of the two control keys: a terminal sends ESC and CR as characters, while the
  // in-memory renderer names them. Accepting only the names left Escape dead on a real keyboard.
  const isEscape = name === "escape" || name === "\x1b";
  const isEnter = name === "return" || name === "enter" || name === "\r" || name === "\n";
  if (isEscape || (name === "q" && !key.ctrl) || (key.ctrl && name === "c")) return { kind: "exit" };
  if (isEnter) return { kind: "focus" };
  if (name === "tab") return { kind: "cycle", step: key.shift ? -1 : 1 };
  if (name === "left") return { kind: "cycle", step: -1 };
  if (name === "right") return { kind: "cycle", step: 1 };
  if (name === "up" || name === "k") return { kind: "scroll", lines: 1 };
  if (name === "down" || name === "j") return { kind: "scroll", lines: -1 };
  if (name === "pageup") return { kind: "scroll", lines: 10 };
  if (name === "pagedown") return { kind: "scroll", lines: -10 };
  if (name === "home" || character === "g") return { kind: "top" };
  if (name === "end" || character === "G") return { kind: "bottom" };

  const digit = character && /^[1-9]$/.test(character) ? Number(character) : undefined;
  if (digit !== undefined) return { kind: "select", index: digit - 1 };
  return { kind: "none" };
}

/**
 * Applies an action, returning a new snapshot.
 *
 * Changing pane resets the scroll to the live edge. Carrying one pane's scroll offset into another
 * would land you at an arbitrary point in a different history — the offset means nothing outside
 * the pane it was measured in.
 */
export function applyAction(snapshot: WorkspaceSnapshot, action: WorkspaceAction): WorkspaceSnapshot {
  const count = snapshot.panes.length;
  if (count === 0 || action.kind === "none" || action.kind === "exit" || action.kind === "focus") return snapshot;

  if (action.kind === "select") {
    if (action.index < 0 || action.index >= count) return snapshot;
    return { ...snapshot, selected: action.index, scroll: 0 };
  }
  if (action.kind === "cycle") {
    const next = (((snapshot.selected + action.step) % count) + count) % count;
    return { ...snapshot, selected: next, scroll: 0 };
  }

  const pane = selectedPane(snapshot);
  const height = paneHeight(snapshot.rows);
  const furthest = Math.max(0, (pane?.lines.length ?? 0) - height);
  if (action.kind === "bottom") return { ...snapshot, scroll: 0 };
  if (action.kind === "top") return { ...snapshot, scroll: furthest };
  return { ...snapshot, scroll: Math.max(0, Math.min(snapshot.scroll + action.lines, furthest)) };
}

/** One cell of the tab bar. Kept as data so the bar can be measured before it is drawn. */
export type PaneTab = { label: string; active: boolean; status: WorkspacePane["status"] };

export function paneTabs(snapshot: WorkspaceSnapshot): PaneTab[] {
  const selected = Math.max(0, Math.min(snapshot.selected, snapshot.panes.length - 1));
  return snapshot.panes.map((pane, index) => ({
    label: `${index + 1} ${pane.title}`,
    active: index === selected,
    status: pane.status,
  }));
}

/**
 * Turns "how many lines does this pane have now" into "how fast is it producing them".
 *
 * The panes themselves keep a bounded log with no timestamps in it, so there is no series to plot
 * without measuring one. Sampling the *difference* between redraws is enough and costs nothing: a
 * pane that gained forty lines since the last frame was busy, one that gained none was not, and the
 * shape of the last few dozen samples is exactly what the header waveline draws.
 *
 * Keyed by pane key, so a closed tab's samples go with it and a reopened one starts fresh rather
 * than inheriting a stranger's history.
 */
export class PaneActivity {
  private readonly series = new Map<string, StreamSeries>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 48) {}

  /** Records this frame's totals and returns the samples to draw, per pane key. */
  sample(panes: readonly { key: string; lines: readonly string[]; dropped: number }[]): Map<string, number[]> {
    const live = new Set(panes.map((pane) => pane.key));
    for (const key of [...this.series.keys()]) {
      if (!live.has(key)) { this.series.delete(key); this.seen.delete(key); }
    }
    const result = new Map<string, number[]>();
    for (const pane of panes) {
      // Dropped lines are counted too: a pane producing faster than its log can hold is the busiest
      // thing on the screen, and reading only `lines.length` would show it as perfectly idle.
      const produced = pane.lines.length + pane.dropped;
      const previous = this.seen.get(pane.key);
      this.seen.set(pane.key, produced);
      const stream = this.series.get(pane.key) ?? new StreamSeries(this.capacity);
      this.series.set(pane.key, stream);
      // The first sighting has no previous total to subtract, and guessing one would draw a spike
      // that never happened.
      if (previous !== undefined) stream.push(Math.max(0, produced - previous));
      result.set(pane.key, stream.values());
    }
    return result;
  }
}

/** Builds panes from the session's tabs — one pane each, in tab order. */
export function tabPanes(
  views: readonly TabView[],
  linesFor: (id: number) => { lines: readonly string[]; dropped: number },
): WorkspacePane[] {
  return views.map((view) => {
    const record = linesFor(view.id);
    const where = view.backend && view.backend !== "local" ? ` · ${view.backend}` : "";
    return {
      kind: "tab" as const,
      key: `${view.id}`,
      title: view.title,
      subtitle: `${view.model ?? "model unknown"}${where}${view.cost ? ` · ${view.cost}` : ""}`,
      status: view.status,
      lines: record.lines,
      dropped: record.dropped,
    };
  });
}

/**
 * One row of the drawn frame: the text, how it is weighted, and what colour it takes.
 *
 * The colour is a *value from the theme*, resolved here rather than in the component, so the panel
 * is painted in whatever the session is painted in — a `/theme nebula` at the prompt changes the
 * control panel too. Kept as a token string (a hex or an ANSI name) because that is what TermUI's
 * `parseColor` accepts, so nothing has to translate on the way to the screen.
 */
export type FrameRow = { text: string; bold?: boolean; inverse?: boolean; dim?: boolean; color?: string };

const STATUS_MARK: Record<WorkspacePane["status"], string> = {
  running: "\u25cf",
  failed: "\u2715",
  done: "\u2713",
  idle: " ",
};

export const WORKSPACE_LEGEND = "1-9 pane \u00b7 \u2190\u2192 move \u00b7 \u2191\u2193 scroll \u00b7 g/G ends \u00b7 q leave";

/** Keeps the active pane named even when the full tab strip cannot fit. */
function paneBar(snapshot: WorkspaceSnapshot, columns: number): string {
  const tabs = paneTabs(snapshot);
  const cells = tabs.map((tab) => ` ${STATUS_MARK[tab.status] ?? " "}${tab.label} `);
  const full = cells.join("");
  if (full.length <= columns) return full || " no panes ";
  const selected = Math.max(0, Math.min(snapshot.selected, tabs.length - 1));
  return `${selected > 0 ? "\u2039 " : ""}${cells[selected] ?? " no panes "}${selected < tabs.length - 1 ? " \u203a" : ""}`;
}

/**
 * The whole frame, row by row, sized to exactly the terminal it will be drawn on.
 *
 * Composed here rather than by a layout engine on purpose. Letting flexbox distribute the rows put
 * the legend in the middle of the transcript the first time a pane held more lines than the window
 * — the sections were sized independently and then overlapped. Composing the frame as a list of
 * exactly `rows` entries makes that class of bug impossible to express, and makes the entire layout
 * checkable by comparing strings, which is how the rest of Nova's rendering is already verified.
 */
export function composeFrame(snapshot: WorkspaceSnapshot): FrameRow[] {
  const rows: FrameRow[] = [];
  const columns = Math.max(1, Math.floor(snapshot.columns));
  const rowCount = Math.max(1, Math.floor(snapshot.rows));
  const pane = selectedPane(snapshot);
  const height = paneHeight(rowCount);
  const theme = snapshot.palette.tokens;

  const bar = paneBar(snapshot, columns);
  rows.push({ text: bar || " no panes ", bold: true, color: theme.primary });

  const scrolled = pane && !atLiveEdge(pane, height, snapshot.scroll);
  // Scroll here counts from the bottom (0 = newest line), but scrollPercent wants an offset counted
  // from the top — the conversion happens once, at this call site, rather than teaching the shared
  // helper two different conventions.
  const position = (() => {
    if (!pane || !scrolled) return "";
    const maxOffset = Math.max(0, pane.lines.length - height);
    const offsetFromTop = maxOffset - Math.min(snapshot.scroll, maxOffset);
    return scrollIndicator(scrollPercent(offsetFromTop, pane.lines.length, height));
  })();
  const dropped = pane && pane.dropped > 0 ? `  (${pane.dropped} earlier lines dropped)` : "";
  // One row tall by construction, which is why the waveline and not the braille plot: it rides on
  // the header beside the title rather than taking rows the pane needs for its output.
  const header = pane ? `${pane.title}  ${pane.subtitle}${dropped}` : "nothing open";
  const activityWidth = Math.min(24, Math.max(0, columns - visibleWidth(header) - 3));
  const activity = pane?.activity && pane.activity.length > 1 && activityWidth >= 8
    ? `  ${waveLine(pane.activity, { width: activityWidth })}`
    : "";
  rows.push({
    text: pane ? `${header}${activity}` : header,
    bold: true,
    // A failing pane is named in the theme's error colour, so which pane is in trouble is answered
    // by the header rather than by reading its output.
    color: pane?.status === "failed" ? theme.error : pane?.status === "running" ? theme.success : theme.accent,
  });

  const body = pane ? visibleLines(pane, height, snapshot.scroll) : [];
  for (let index = 0; index < height; index += 1) rows.push({ text: body[index] ?? "" });

  // Padding, so the frame always occupies the same rows and a shorter pane cannot let the previous
  // frame's text show through underneath it.
  while (rows.length < rowCount - 1) rows.push({ text: "" });
  rows.length = Math.max(0, rowCount - 1);
  rows.push({
    text: `${WORKSPACE_LEGEND}${scrolled ? `   \u25b2 scrolled back  ${position}` : ""}`,
    dim: true,
    color: theme.textMuted,
  });
  // An over-wide Text widget wraps and consumes a row the frame did not reserve, moving the footer
  // into the pane. The finished frame is clipped once here so every caller gets the same guarantee.
  return rows.map((row) => ({ ...row, text: clip(row.text, columns) }));
}
