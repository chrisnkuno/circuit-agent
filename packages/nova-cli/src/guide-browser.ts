import { GUIDE_TOPICS, wrapText, type GuideTopic } from "./guide";
import { visibleWidth } from "./markdown";

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
};

export function initialGuideState(columns: number, rows: number): GuideBrowserState {
  return { topics: GUIDE_TOPICS, selected: 0, scroll: 0, query: "", searching: false, columns, rows };
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
  return Math.max(14, Math.min(26, Math.floor(columns * 0.28)));
}

/** Rows of body available, once the header and the footer have taken one each. */
export function bodyHeight(rows: number): number {
  return Math.max(1, rows - 2);
}

export type GuideAction =
  | { kind: "move"; step: number }
  | { kind: "scroll"; rows: number }
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
  if (name === "pagedown" || character === " ") return { kind: "scroll", rows: 10 };
  if (name === "pageup") return { kind: "scroll", rows: -10 };
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
    case "scroll": {
      const topic = currentTopic(state);
      if (!topic) return state;
      const height = bodyHeight(state.rows);
      const total = topicLines(topic, bodyWidth(state.columns)).length;
      const furthest = Math.max(0, total - height);
      return { ...state, scroll: Math.max(0, Math.min(state.scroll + action.rows, furthest)) };
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
  return Math.max(20, columns - sidebarWidth(columns) - 3);
}

export type GuideRow = { text: string; bold?: boolean; dim?: boolean; inverse?: boolean };

/**
 * A topic's page, wrapped to the body column.
 *
 * Examples are laid out as a command followed by its explanation indented beneath, always — the
 * two-column form used in the printed guide depends on knowing the full terminal width, and here
 * the body is a fraction of it.
 */
export function topicLines(topic: GuideTopic, width: number): GuideRow[] {
  // The title wraps like everything else. "Tabs: several pieces of work at once" is wider than a
  // narrow body column, and a heading that runs off the edge is the first thing a reader sees.
  const rows: GuideRow[] = [
    ...wrapText(topic.title, width).map((line) => ({ text: line, bold: true })),
    { text: "" },
  ];
  for (const paragraph of topic.body) {
    for (const line of wrapText(paragraph, width)) rows.push({ text: line });
    rows.push({ text: "" });
  }
  if (topic.examples && topic.examples.length > 0) {
    rows.push({ text: "try", bold: true });
    for (const example of topic.examples) {
      // Commands wrap on their spaces with a hanging indent rather than being clipped: half a flag
      // is not something anyone can type, and a narrow window is exactly where someone is most
      // likely to be reading the guide instead of remembering the syntax.
      const [head, ...rest] = wrapText(example.input, Math.max(10, width - 2));
      rows.push({ text: `  ${head ?? ""}`, bold: true });
      for (const line of rest) rows.push({ text: `    ${line}`, bold: true });
      for (const line of wrapText(example.effect, Math.max(10, width - 4))) rows.push({ text: `    ${line}`, dim: true });
    }
  }
  return rows;
}

function pad(text: string, width: number): string {
  const size = visibleWidth(text);
  return size >= width ? sliceToWidth(text, width) : text + " ".repeat(width - size);
}

/** Cuts to a column count. The guide's own text is plain, so counting characters is honest here. */
function sliceToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  for (const character of text) {
    if (visibleWidth(out + character) > width) break;
    out += character;
  }
  return out;
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
  const sidebar = sidebarWidth(state.columns);
  const body = bodyWidth(state.columns);
  const height = bodyHeight(state.rows);
  const topics = visibleTopics(state);
  const selectedIndex = topics.length === 0 ? -1 : Math.max(0, Math.min(state.selected, topics.length - 1));
  const topic = selectedIndex === -1 ? undefined : topics[selectedIndex];

  const rows: GuideRow[] = [];
  rows.push({ text: pad(" nova guide", sidebar + body + 3), bold: true, inverse: true });

  const lines = topic ? topicLines(topic, body) : [{ text: "Nothing matches that." }];
  const start = Math.max(0, Math.min(state.scroll, Math.max(0, lines.length - height)));
  const window = lines.slice(start, start + height);

  // The list scrolls with the selection, so a long list never hides the topic you are on.
  const listStart = Math.max(0, Math.min(selectedIndex - Math.floor(height / 2), Math.max(0, topics.length - height)));

  for (let offset = 0; offset < height; offset += 1) {
    const listed = topics[listStart + offset];
    const chosen = listed !== undefined && listStart + offset === selectedIndex;
    const cell = listed ? `${chosen ? "›" : " "} ${listed.title}` : "";
    const line = window[offset];
    rows.push({
      text: `${pad(sliceToWidth(cell, sidebar), sidebar)} │ ${pad(line?.text ?? "", body)}`,
      bold: chosen || line?.bold,
      dim: line?.dim && !chosen,
    });
  }

  const footer = state.searching
    ? `search: ${state.query}▏  Enter done · Esc done`
    : `↑↓ topic · ←→ scroll · space page · / search · q leave${state.query ? `   filter: ${state.query}` : ""}`;
  rows.push({ text: pad(` ${footer}`, sidebar + body + 3), dim: true });
  return rows;
}
