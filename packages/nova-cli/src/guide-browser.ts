import { GUIDE_TOPICS, wrapText, type GuideTopic } from "./guide";
import { NO_COLOR_PALETTE, type Palette } from "./theme";
import { visibleWidth } from "./markdown";
import { joinHorizontal, padToWidth as pad, scrollIndicator, scrollPercent, sliceToWidth } from "./tui";
import { applyViewport, newViewport, visibleLines } from "./viewport";

/**
 * The guide as something you move around in, rather than something printed at you.
 *
 * `/guide tabs` prints a topic into the transcript, which is right when you want to keep it, quote
 * it or pipe it. It is wrong for the case the guide mostly serves: not knowing what you are looking
 * for. Reading a manual is a browsing activity — a list on the left, a page on the right, arrow keys
 * — and a transcript cannot offer that without reprinting the whole index between every page.
 *
 * So this is the second surface, on the same terms as the control panel: every decision here is a
 * pure function of the state below, and the framework only turns the finished rows into widgets.
 * The layout is composed rather than delegated to a layout engine for the same reason it is in the
 * workspace — independently sized boxes overlap the moment content outgrows them.
 */

export type GuideBrowserState = {
  /** Every topic, unfiltered. Filtering is derived, never stored. */
  topics: readonly GuideTopic[];
  /** Index into the *visible* topics. */
  selected: number;
  /** Rows scrolled down the body of the selected topic. */
  scroll: number;
  /** The live filter. Empty means everything. */
  query: string;
  /** True while keystrokes go to the filter instead of to navigation. */
  searching: boolean;
  columns: number;
  rows: number;
  /** The session's theme, so the guide is painted in whatever the transcript is painted in. */
  palette: Palette;
};

export function initialGuideState(columns: number, rows: number, palette: Palette = NO_COLOR_PALETTE): GuideBrowserState {
  return { topics: GUIDE_TOPICS, selected: 0, scroll: 0, query: "", searching: false, columns, rows, palette };
}

/** The topics the filter admits. A filter that matches nothing shows nothing, and says so. */
export function visibleTopics(state: GuideBrowserState): GuideTopic[] {
  const needle = state.query.trim().toLowerCase();
  if (!needle) return [...state.topics];
  return state.topics.filter((topic) =>
    [topic.title, topic.summary, topic.id, ...topic.body, ...(topic.examples ?? []).flatMap((example) => [example.input, example.effect])]
      .some((text) => text.toLowerCase().includes(needle)));
}

export function currentTopic(state: GuideBrowserState): GuideTopic | undefined {
  const topics = visibleTopics(state);
  if (topics.length === 0) return undefined;
  return topics[Math.max(0, Math.min(state.selected, topics.length - 1))];
}

/** Width of the topic list. Bounded at both ends: unreadable below 14, wasteful above 26. */
export function sidebarWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.min(width, Math.max(14, Math.min(26, Math.floor(width * 0.28))));
}

/** Rows of body available, once the header and the footer have taken one each. */
export function bodyHeight(rows: number): number {
  return Math.max(0, Math.floor(rows) - 2);
}

export type GuideAction =
  | { kind: "move"; step: number }
  | { kind: "scroll"; rows: number }
  | { kind: "page"; step: 1 | -1 }
  | { kind: "search" }
  | { kind: "type"; character: string }
  | { kind: "backspace" }
  | { kind: "commit" }
  | { kind: "exit" }
  | { kind: "none" };

/**
 * What a key does.
 *
 * Two modes, and the distinction is the whole reason searching is usable: while the filter is open
 * every printable key is *text*, so typing "tabs" filters instead of triggering four navigation
 * shortcuts. Escape closes the filter rather than the guide — the first Escape undoes what you are
 * doing, and only the second leaves, which is the behaviour every editor has trained people to
 * expect.
 */
export function keyToGuideAction(
  key: { name?: string; ctrl?: boolean; shift?: boolean },
  character: string | undefined,
  searching: boolean,
): GuideAction {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { kind: "exit" };
  // A real terminal sends control characters, not names: Enter arrives as CR and Escape as ESC.
  // Matching only the names worked in every unit test and left the filter impossible to close on
  // an actual keyboard — the exact class of bug a pty exists to catch.
  const isEnter = name === "return" || name === "enter" || name === "\r" || name === "\n";
  const isEscape = name === "escape" || name === "\x1b";

  if (searching) {
    if (isEscape || isEnter) return { kind: "commit" };
    if (name === "backspace") return { kind: "backspace" };
    if (name === "up") return { kind: "move", step: -1 };
    if (name === "down") return { kind: "move", step: 1 };
    // A single printable character is text. Named keys arrive with their name as `character` too
    // (see the input adapter), so anything longer than one character is a key, not typing.
    if (character && character.length === 1 && character >= " ") return { kind: "type", character };
    return { kind: "none" };
  }

  if (isEscape || name === "q") return { kind: "exit" };
  if (character === "/" || name === "f3") return { kind: "search" };
  if (name === "up" || name === "k") return { kind: "move", step: -1 };
  if (name === "down" || name === "j") return { kind: "move", step: 1 };
  if (name === "tab") return { kind: "move", step: key.shift ? -1 : 1 };
  // A page is the window's own height less one row of overlap, which the viewport works out — a
  // fixed ten rows scrolled past content on a tall terminal and skipped lines on a short one.
  if (name === "pagedown" || character === " ") return { kind: "page", step: 1 };
  if (name === "pageup") return { kind: "page", step: -1 };
  if (name === "right") return { kind: "scroll", rows: 1 };
  if (name === "left") return { kind: "scroll", rows: -1 };
  return { kind: "none" };
}

export function applyGuideAction(state: GuideBrowserState, action: GuideAction): GuideBrowserState {
  const topics = visibleTopics(state);
  switch (action.kind) {
    case "move": {
      if (topics.length === 0) return state;
      const next = (((state.selected + action.step) % topics.length) + topics.length) % topics.length;
      // A new topic starts at its beginning: a scroll offset measured in another page means nothing.
      return { ...state, selected: next, scroll: 0 };
    }
    case "scroll":
    case "page": {
      const topic = currentTopic(state);
      if (!topic) return state;
      // The shared viewport owns the arithmetic — clamping, the last reachable line, and what a
      // page means at the end of the content — so this screen and the file view cannot disagree
      // about any of it.
      const lines = topicLines(topic, bodyWidth(state.columns)).map((line) => line.text);
      const viewport = { ...newViewport(lines, bodyHeight(state.rows)), top: state.scroll };
      const moved = action.kind === "page"
        ? applyViewport(viewport, { kind: action.step === 1 ? "pageDown" : "pageUp" })
        : applyViewport(viewport, action.rows > 0 ? { kind: "down", rows: action.rows } : { kind: "up", rows: -action.rows });
      return { ...state, scroll: moved.top };
    }
    case "search":
      return { ...state, searching: true };
    case "commit":
      return { ...state, searching: false };
    case "backspace":
      return { ...state, query: state.query.slice(0, -1), selected: 0, scroll: 0 };
    case "type":
      return { ...state, query: state.query + action.character, selected: 0, scroll: 0 };
    default:
      return state;
  }
}

export function bodyWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return width < 40 ? width : Math.max(1, width - sidebarWidth(width) - 3);
}

/**
 * One drawn row. `color` is a theme *token value* (a hex or an ANSI name), not an escape code:
 * TermUI's `parseColor` takes the value and emits the escape itself.
 */
export type GuideRow = { text: string; bold?: boolean; dim?: boolean; inverse?: boolean; color?: string };

/**
 * A topic's page, wrapped to the body column.
 *
 * Examples are laid out as a command followed by its explanation indented beneath, always — the
 * two-column form used in the printed guide depends on knowing the full terminal width, and here
 * the body is a fraction of it.
 */
export function topicLines(topic: GuideTopic, width: number): GuideRow[] {
  const measure = Math.max(1, Math.floor(width));
  const wrap = (text: string, available = measure): string[] => wrapText(text, Math.max(1, available))
    .flatMap((line) => hardWrap(line, Math.max(1, available)));
  // The title wraps like everything else. "Tabs: several pieces of work at once" is wider than a
  // narrow body column, and a heading that runs off the edge is the first thing a reader sees.
  const rows: GuideRow[] = [
    ...wrap(topic.title).map((line) => ({ text: line, bold: true })),
    { text: "" },
  ];
  for (const paragraph of topic.body) {
    for (const line of wrap(paragraph)) rows.push({ text: line });
    rows.push({ text: "" });
  }
  if (topic.examples && topic.examples.length > 0) {
    rows.push({ text: "try", bold: true });
    for (const example of topic.examples) {
      // Commands wrap on their spaces with a hanging indent rather than being clipped: half a flag
      // is not something anyone can type, and a narrow window is exactly where someone is most
      // likely to be reading the guide instead of remembering the syntax.
      const commandIndent = " ".repeat(Math.min(2, Math.max(0, measure - 1)));
      const detailIndent = " ".repeat(Math.min(4, Math.max(0, measure - 1)));
      const [head, ...rest] = wrap(example.input, measure - visibleWidth(detailIndent));
      rows.push({ text: `${commandIndent}${head ?? ""}`, bold: true });
      for (const line of rest) rows.push({ text: `${detailIndent}${line}`, bold: true });
      for (const line of wrap(example.effect, measure - visibleWidth(detailIndent))) rows.push({ text: `${detailIndent}${line}`, dim: true });
    }
  }
  return rows;
}

/** Preserves long tokens by continuing them on the next row instead of letting a widget wrap. */
function hardWrap(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let line = "";
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((entry) => entry.segment)
    : [...text];
  for (const segment of segments) {
    if (line && visibleWidth(line + segment) > width) {
      lines.push(line);
      line = "";
    }
    if (visibleWidth(segment) > width) {
      lines.push("\u2026");
      continue;
    }
    line += segment;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The whole screen, row by row, exactly `rows` tall.
 *
 * Composed as complete lines — sidebar cell, separator, body cell — rather than as two columns the
 * layout engine is asked to place side by side. The workspace panel was built the other way first
 * and the sections overlapped as soon as one outgrew its box; doing it here as string arithmetic
 * makes that impossible and makes the whole layout checkable by comparing text.
 */
export function composeGuideFrame(state: GuideBrowserState): GuideRow[] {
  const columns = Math.max(1, Math.floor(state.columns));
  const rowCount = Math.max(1, Math.floor(state.rows));
  const compact = columns < 40;
  const sidebar = compact ? 0 : sidebarWidth(columns);
  const body = bodyWidth(columns);
  const height = bodyHeight(rowCount);
  const topics = visibleTopics(state);
  const selectedIndex = topics.length === 0 ? -1 : Math.max(0, Math.min(state.selected, topics.length - 1));
  const topic = selectedIndex === -1 ? undefined : topics[selectedIndex];

  const theme = state.palette.tokens;
  const rows: GuideRow[] = [];
  rows.push({
    text: pad(compact ? ` nova guide · ${topic?.title ?? "no matches"}` : " nova guide", columns),
    bold: true,
    color: theme.primary,
  });
  if (rowCount === 1) return rows;

  const lines = topic ? topicLines(topic, body) : [{ text: "Nothing matches that." }];
  // Indices through the viewport, then read back out of `lines` — the rows carry styling the
  // viewport neither knows nor needs to know about.
  const indices = visibleLines({ ...newViewport(lines.map((_, index) => `${index}`), height), top: state.scroll });
  const start = indices.length > 0 ? Number(indices[0]) : 0;
  const window = lines.slice(start, start + height);

  // The list scrolls with the selection, so a long list never hides the topic you are on.
  const listStart = Math.max(0, Math.min(selectedIndex - Math.floor(height / 2), Math.max(0, topics.length - height)));

  for (let offset = 0; offset < height; offset += 1) {
    const listed = topics[listStart + offset];
    const chosen = listed !== undefined && listStart + offset === selectedIndex;
    const cell = listed ? `${chosen ? "›" : " "} ${listed.title}` : "";
    const line = window[offset];
    rows.push({
      text: compact
        ? pad(line?.text ?? "", columns)
        : joinHorizontal(sliceToWidth(cell, sidebar), line?.text ?? "", { leftWidth: sidebar, rightWidth: body, separator: " │ " }),
      bold: chosen || line?.bold,
      dim: line?.dim && !chosen,
      // The selected topic takes the accent; a body heading takes the primary; prose is left to
      // the terminal's own foreground, which is the one colour a reader has already chosen.
      ...(chosen ? { color: theme.accent } : line?.bold ? { color: theme.primary } : {}),
    });
  }

  // Only worth naming once there is something to scroll through — a short topic has nothing to
  // report and "Top" beside every single page would just be noise.
  const position = lines.length > height ? `  ${scrollIndicator(scrollPercent(start, lines.length, height))}` : "";
  const footer = state.searching
    ? `search: ${state.query}▏  Enter done · Esc done`
    : `↑↓ topic · ←→ scroll · space page · / search · q leave${state.query ? `   filter: ${state.query}` : ""}${position}`;
  rows.push({ text: pad(` ${footer}`, columns), dim: true, color: theme.textMuted });
  return rows;
}
