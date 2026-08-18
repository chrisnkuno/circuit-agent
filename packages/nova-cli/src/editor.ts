/**
 * A small modal text editor, for editing a file without leaving Nova.
 *
 * The design target is the middle ground the two obvious choices both miss. `nano` is discoverable —
 * the shortcuts are printed along the bottom and you can start typing immediately — but editing in
 * it is all arrow keys, so any real change is slow. `vim` is fast once learned and unusable until
 * then, and an editor that traps someone who opened it by accident is worse than no editor at all.
 *
 * So: vim's modes and motions, nano's visible key bar and its `Ctrl+S`/`Ctrl+Q`, and an `Escape`
 * that always goes somewhere safer rather than deeper. Insert mode is entered explicitly, but the
 * hint bar says how, and quitting is one chord that works from either mode.
 *
 * Everything here is a pure function over `EditorState`. No file is read or written, no key is
 * listened for, nothing is drawn — the same split `file-browser.ts` uses, and for the same reason:
 * the interesting behaviour is the state machine, and a state machine that owns a terminal can only
 * be tested by driving a terminal.
 */

export type EditorMode = "normal" | "insert";

export type Cursor = { row: number; col: number };

export type EditorState = {
  path: string;
  /** Never empty: an empty document is `[""]`, one empty line, so the cursor always has a home. */
  lines: string[];
  cursor: Cursor;
  mode: EditorMode;
  /** Index of the first visible line. Owned by the state so scrolling survives a re-render. */
  scroll: number;
  /** How many lines fit on screen. Set from the terminal; drives scrolling. */
  viewportRows: number;
  dirty: boolean;
  /** Undo stack. Snapshots of the whole document, which is cheap for the sizes an agent edits. */
  history: Array<{ lines: string[]; cursor: Cursor }>;
  future: Array<{ lines: string[]; cursor: Cursor }>;
  /** First key of a two-key sequence (`d` of `dd`, `g` of `gg`) awaiting its second. */
  pending?: string;
  /** Active search query, and whether the prompt is currently taking input. */
  search: { query: string; typing: boolean };
  /** One-line feedback under the key bar: "saved", "no matches", and the like. */
  message?: string;
};

export type EditorAction =
  | { kind: "move"; rows?: number; cols?: number }
  | { kind: "jump"; to: "lineStart" | "lineEnd" | "fileStart" | "fileEnd" | "wordForward" | "wordBack" }
  | { kind: "insert"; at?: "before" | "after" | "lineStart" | "lineEnd" | "below" | "above" }
  | { kind: "normal" }
  | { kind: "type"; character: string }
  | { kind: "newline" }
  | { kind: "backspace" }
  | { kind: "deleteChar" }
  | { kind: "deleteLine" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "save" }
  | { kind: "quit" }
  | { kind: "search" }
  | { kind: "searchType"; character: string }
  | { kind: "searchBackspace" }
  | { kind: "searchCommit" }
  | { kind: "searchNext" }
  | { kind: "pending"; key: string }
  | { kind: "none" };

export function initialEditorState(path: string, content: string, viewportRows = 20): EditorState {
  // `split` on an empty string yields `[""]`, which is exactly right — one empty line, not zero.
  const lines = content.split("\n");
  return {
    path,
    lines,
    cursor: { row: 0, col: 0 },
    mode: "normal",
    scroll: 0,
    viewportRows: Math.max(1, viewportRows),
    dirty: false,
    history: [],
    future: [],
    search: { query: "", typing: false },
  };
}

/** The document as text. The inverse of `initialEditorState`'s split, so a round trip is exact. */
export function editorContent(state: EditorState): string {
  return state.lines.join("\n");
}

/**
 * Clamps the cursor into the document.
 *
 * Called after every mutation rather than trusted to each one. Every editing bug of the class
 * "cursor is past the end of a line that just got shorter" is prevented here once, instead of in
 * each of the fifteen places that can shorten a line.
 *
 * The column bound differs by mode, and that is not an oversight: in insert mode the cursor sits
 * *after* the last character (you must be able to append), while in normal mode it sits *on* a
 * character, so the last valid column is one less. Vim does the same thing for the same reason.
 */
function clamp(state: EditorState): EditorState {
  const row = Math.max(0, Math.min(state.lines.length - 1, state.cursor.row));
  const limit = state.mode === "insert" ? state.lines[row].length : Math.max(0, state.lines[row].length - 1);
  const col = Math.max(0, Math.min(limit, state.cursor.col));

  // Scroll follows the cursor, moving as little as possible: only when the cursor has actually left
  // the window, and only far enough to bring it back to the edge it left by.
  let scroll = state.scroll;
  if (row < scroll) scroll = row;
  if (row >= scroll + state.viewportRows) scroll = row - state.viewportRows + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, state.lines.length - 1)));

  return { ...state, cursor: { row, col }, scroll };
}

/** Pushes an undo snapshot and drops the redo stack, which a new edit invalidates. */
function checkpoint(state: EditorState): EditorState {
  return {
    ...state,
    history: [...state.history, { lines: [...state.lines], cursor: { ...state.cursor } }].slice(-200),
    future: [],
  };
}

const WORD = /[A-Za-z0-9_]/;

/** Start of the next word, vim's `w`: past the current run, then past the gap. */
function wordForward(line: string, col: number): number {
  let index = col;
  while (index < line.length && WORD.test(line[index])) index += 1;
  while (index < line.length && !WORD.test(line[index])) index += 1;
  return index;
}

/** Start of the previous word, vim's `b`: back over any gap, then to the head of that run. */
function wordBack(line: string, col: number): number {
  let index = Math.max(0, col - 1);
  while (index > 0 && !WORD.test(line[index])) index -= 1;
  while (index > 0 && WORD.test(line[index - 1])) index -= 1;
  return index;
}

/**
 * What a key means, given the mode it was pressed in.
 *
 * Split by mode first, because the same byte means different things: `i` is "enter insert mode" in
 * normal and the letter i in insert. Getting that precedence wrong is what makes a modal editor
 * feel haunted.
 *
 * `Ctrl+S` and `Ctrl+Q` are checked before either branch. They work from every mode on purpose —
 * they are the two things someone who does not know this editor will try, and both must work
 * without first requiring them to know about modes.
 */
export function keyToEditorAction(
  key: { name?: string; ctrl?: boolean; shift?: boolean },
  character: string | undefined,
  state: EditorState,
): EditorAction {
  const name = key.name ?? "";
  const isEnter = name === "return" || name === "enter";
  const isEscape = name === "escape";

  if (key.ctrl && name === "s") return { kind: "save" };
  if (key.ctrl && (name === "q" || name === "c")) return { kind: "quit" };

  if (state.search.typing) {
    if (isEscape) return { kind: "searchCommit" };
    if (isEnter) return { kind: "searchNext" };
    if (name === "backspace") return { kind: "searchBackspace" };
    if (character && character.length === 1 && character >= " ") return { kind: "searchType", character };
    return { kind: "none" };
  }

  if (state.mode === "insert") {
    if (isEscape) return { kind: "normal" };
    if (isEnter) return { kind: "newline" };
    if (name === "backspace") return { kind: "backspace" };
    if (name === "up") return { kind: "move", rows: -1 };
    if (name === "down") return { kind: "move", rows: 1 };
    if (name === "left") return { kind: "move", cols: -1 };
    if (name === "right") return { kind: "move", cols: 1 };
    // Tab is two spaces of text, not a focus change: there is nothing else here to focus.
    if (name === "tab") return { kind: "type", character: "  " };
    if (character && character.length === 1 && character >= " ") return { kind: "type", character };
    return { kind: "none" };
  }

  // A pending first key consumes the next one, so `dd` and `gg` cannot be split by an arrow key.
  if (state.pending === "d") return name === "d" || character === "d" ? { kind: "deleteLine" } : { kind: "normal" };
  if (state.pending === "g") return name === "g" || character === "g" ? { kind: "jump", to: "fileStart" } : { kind: "normal" };

  if (isEscape) return { kind: "normal" };
  if (name === "up" || character === "k") return { kind: "move", rows: -1 };
  if (name === "down" || character === "j") return { kind: "move", rows: 1 };
  if (name === "left" || character === "h") return { kind: "move", cols: -1 };
  if (name === "right" || character === "l") return { kind: "move", cols: 1 };
  if (name === "pageup") return { kind: "move", rows: -state.viewportRows };
  if (name === "pagedown") return { kind: "move", rows: state.viewportRows };
  if (character === "0" || name === "home") return { kind: "jump", to: "lineStart" };
  if (character === "$" || name === "end") return { kind: "jump", to: "lineEnd" };
  if (character === "G") return { kind: "jump", to: "fileEnd" };
  if (character === "w") return { kind: "jump", to: "wordForward" };
  if (character === "b") return { kind: "jump", to: "wordBack" };
  if (character === "i") return { kind: "insert" };
  if (character === "a") return { kind: "insert", at: "after" };
  if (character === "I") return { kind: "insert", at: "lineStart" };
  if (character === "A") return { kind: "insert", at: "lineEnd" };
  if (character === "o") return { kind: "insert", at: "below" };
  if (character === "O") return { kind: "insert", at: "above" };
  if (character === "x") return { kind: "deleteChar" };
  if (character === "u") return { kind: "undo" };
  if (key.ctrl && name === "r") return { kind: "redo" };
  if (character === "/") return { kind: "search" };
  if (character === "n") return { kind: "searchNext" };
  if (character === "d" || character === "g") return { kind: "pending", key: character };
  return { kind: "none" };
}

/** Signals the host needs to act on, since a pure reducer cannot write a file or close a screen. */
export type EditorEffect = { kind: "save" } | { kind: "quit" } | undefined;

export function applyEditorAction(state: EditorState, action: EditorAction): { state: EditorState; effect: EditorEffect } {
  const plain = (next: EditorState) => ({ state: clamp({ ...next, pending: undefined }), effect: undefined as EditorEffect });
  const line = state.lines[state.cursor.row] ?? "";

  switch (action.kind) {
    case "move":
      return plain({
        ...state,
        message: undefined,
        cursor: { row: state.cursor.row + (action.rows ?? 0), col: state.cursor.col + (action.cols ?? 0) },
      });

    case "jump": {
      const targets: Record<string, Cursor> = {
        lineStart: { row: state.cursor.row, col: 0 },
        lineEnd: { row: state.cursor.row, col: line.length },
        fileStart: { row: 0, col: 0 },
        fileEnd: { row: state.lines.length - 1, col: 0 },
        wordForward: { row: state.cursor.row, col: wordForward(line, state.cursor.col) },
        wordBack: { row: state.cursor.row, col: wordBack(line, state.cursor.col) },
      };
      return plain({ ...state, message: undefined, cursor: targets[action.to] });
    }

    case "insert": {
      // `o` and `O` open a line, which is a document change and so needs an undo checkpoint; the
      // other four only move the cursor and must not push one, or undo would replay cursor moves.
      if (action.at === "below" || action.at === "above") {
        const at = action.at === "below" ? state.cursor.row + 1 : state.cursor.row;
        const next = checkpoint(state);
        const lines = [...state.lines];
        lines.splice(at, 0, "");
        return plain({ ...next, lines, dirty: true, mode: "insert", cursor: { row: at, col: 0 } });
      }
      const col = action.at === "after" ? state.cursor.col + 1
        : action.at === "lineStart" ? 0
        : action.at === "lineEnd" ? line.length
        : state.cursor.col;
      return plain({ ...state, mode: "insert", message: undefined, cursor: { row: state.cursor.row, col } });
    }

    case "normal":
      return plain({ ...state, mode: "normal", message: undefined });

    case "type": {
      const next = checkpoint(state);
      const lines = [...state.lines];
      lines[state.cursor.row] = line.slice(0, state.cursor.col) + action.character + line.slice(state.cursor.col);
      return plain({ ...next, lines, dirty: true, cursor: { row: state.cursor.row, col: state.cursor.col + action.character.length } });
    }

    case "newline": {
      const next = checkpoint(state);
      const lines = [...state.lines];
      lines.splice(state.cursor.row, 1, line.slice(0, state.cursor.col), line.slice(state.cursor.col));
      return plain({ ...next, lines, dirty: true, cursor: { row: state.cursor.row + 1, col: 0 } });
    }

    case "backspace": {
      if (state.cursor.col === 0 && state.cursor.row === 0) return plain(state);
      const next = checkpoint(state);
      const lines = [...state.lines];
      if (state.cursor.col === 0) {
        // At column zero, backspace joins this line onto the previous one — and the cursor lands at
        // the join, which is where the previous line used to end.
        const previous = lines[state.cursor.row - 1];
        lines.splice(state.cursor.row - 1, 2, previous + line);
        return plain({ ...next, lines, dirty: true, cursor: { row: state.cursor.row - 1, col: previous.length } });
      }
      lines[state.cursor.row] = line.slice(0, state.cursor.col - 1) + line.slice(state.cursor.col);
      return plain({ ...next, lines, dirty: true, cursor: { row: state.cursor.row, col: state.cursor.col - 1 } });
    }

    case "deleteChar": {
      if (line.length === 0) return plain(state);
      const next = checkpoint(state);
      const lines = [...state.lines];
      lines[state.cursor.row] = line.slice(0, state.cursor.col) + line.slice(state.cursor.col + 1);
      return plain({ ...next, lines, dirty: true });
    }

    case "deleteLine": {
      const next = checkpoint(state);
      const lines = [...state.lines];
      lines.splice(state.cursor.row, 1);
      // Deleting the only line leaves one empty line rather than no lines: the document invariant
      // is that `lines` is never empty, so the cursor always has somewhere to be.
      return plain({ ...next, lines: lines.length > 0 ? lines : [""], dirty: true, cursor: { row: state.cursor.row, col: 0 } });
    }

    case "undo": {
      const previous = state.history.at(-1);
      if (!previous) return plain({ ...state, message: "nothing to undo" });
      return plain({
        ...state,
        lines: previous.lines,
        cursor: previous.cursor,
        history: state.history.slice(0, -1),
        future: [...state.future, { lines: [...state.lines], cursor: { ...state.cursor } }],
        dirty: true,
        message: undefined,
      });
    }

    case "redo": {
      const next = state.future.at(-1);
      if (!next) return plain({ ...state, message: "nothing to redo" });
      return plain({
        ...state,
        lines: next.lines,
        cursor: next.cursor,
        future: state.future.slice(0, -1),
        history: [...state.history, { lines: [...state.lines], cursor: { ...state.cursor } }],
        dirty: true,
        message: undefined,
      });
    }

    case "save":
      // `dirty` is cleared here rather than by the host, so the reducer's own view of "saved" is
      // what the key bar renders. The host still has to actually write the file.
      return { state: clamp({ ...state, dirty: false, message: `saved ${state.path}`, pending: undefined }), effect: { kind: "save" } };

    case "quit":
      return { state, effect: { kind: "quit" } };

    case "search":
      return plain({ ...state, search: { query: "", typing: true }, message: undefined });

    case "searchType":
      return plain({ ...state, search: { ...state.search, query: state.search.query + action.character } });

    case "searchBackspace":
      return plain({ ...state, search: { ...state.search, query: state.search.query.slice(0, -1) } });

    case "searchCommit":
      return plain({ ...state, search: { ...state.search, typing: false } });

    case "searchNext": {
      const query = state.search.query;
      if (!query) return plain({ ...state, search: { ...state.search, typing: false } });
      // Wraps around the end of the document, searching forward from just past the cursor. The
      // rotation is what makes `n` keep working at the last match instead of going silent.
      const order = [...state.lines.keys()].map((offset) => (state.cursor.row + offset) % state.lines.length);
      for (const [index, row] of order.entries()) {
        const from = index === 0 ? state.cursor.col + 1 : 0;
        const found = state.lines[row].indexOf(query, from);
        if (found >= 0) {
          return plain({ ...state, cursor: { row, col: found }, search: { ...state.search, typing: false }, message: undefined });
        }
      }
      return plain({ ...state, search: { ...state.search, typing: false }, message: `no match for "${query}"` });
    }

    case "pending":
      return { state: { ...state, pending: action.key }, effect: undefined };

    default:
      return plain(state);
  }
}

/**
 * The key bar, nano's one genuinely great idea.
 *
 * Mode-specific, because showing every binding at once is the same as showing none — the reason
 * nano's bar works is that it is short enough to actually read. Insert mode advertises the way out
 * first, since that is the only thing someone stuck in it needs.
 */
export function editorKeyBar(state: EditorState, columns = Number.POSITIVE_INFINITY): string {
  if (state.search.typing) return `/${state.search.query}   enter next   esc done`;
  if (state.mode === "insert") return "esc normal   ^S save   ^Q quit";

  // Hints in display order, each with whether it may be dropped. On a narrow terminal the bar was
  // simply clipped, which cut `^S save` and `^Q quit` off the right-hand end — losing exactly the
  // two hints someone who cannot get out of the editor needs, and keeping the ones they do not.
  // So the optional hints are dropped from the least useful backwards until the bar fits.
  const hints: Array<{ text: string; essential?: boolean }> = [
    { text: "i insert" },
    { text: "o new line" },
    { text: "x del" },
    { text: "dd del line" },
    { text: "u undo" },
    { text: "/ find" },
    { text: "^S save", essential: true },
    { text: "^Q quit", essential: true },
  ];
  const optional = hints.filter((hint) => !hint.essential);
  for (let dropped = 0; dropped <= optional.length; dropped += 1) {
    const keep = new Set(optional.slice(0, optional.length - dropped));
    const bar = hints.filter((hint) => hint.essential || keep.has(hint)).map((hint) => hint.text).join("   ");
    if (bar.length <= columns) return bar;
  }
  return "^S save   ^Q quit";
}

/** The status line: what file, whether it is modified, and where the cursor is. */
export function editorStatus(state: EditorState): string {
  const position = `${state.cursor.row + 1}:${state.cursor.col + 1}`;
  return `${state.path}${state.dirty ? " [+]" : ""}   ${state.mode}   ${position}   ${state.lines.length} lines`;
}

/** The slice of lines currently on screen, with their absolute numbers for the gutter. */
export function visibleEditorLines(state: EditorState): Array<{ number: number; text: string }> {
  return state.lines
    .slice(state.scroll, state.scroll + state.viewportRows)
    .map((text, offset) => ({ number: state.scroll + offset + 1, text }));
}

export type EditorRow = { text: string; bold?: boolean; dim?: boolean; color?: string };

/**
 * The whole screen as styled rows: status, the visible text with its gutter, then the key bar.
 *
 * Composed here rather than in the widget layer for the same reason `composeFileFrame` is — the row
 * arithmetic (how many lines fit, where the cursor caret goes, what the gutter is padded to) is the
 * part worth testing, and it is testable only while it is a value rather than a rendered tree.
 */
export function composeEditorFrame(state: EditorState, columns: number, accent?: string): EditorRow[] {
  const gutter = String(state.lines.length).length;
  const clip = (text: string) => (text.length <= columns ? text : text.slice(0, Math.max(0, columns - 1)));
  return [
    { text: clip(editorStatus(state)), bold: true, ...(accent ? { color: accent } : {}) },
    ...visibleEditorLines(state).map((entry) => ({
      text: clip(`${String(entry.number).padStart(gutter, " ")} ${caretInto(entry.text, entry.number - 1 === state.cursor.row ? state.cursor.col : undefined)}`),
    })),
    { text: clip(state.message ?? editorKeyBar(state, columns)), dim: true },
  ];
}

/**
 * Marks the cursor inside a line of text.
 *
 * A block character rather than a real terminal cursor: the screen is repainted as whole rows, so
 * there is no hardware cursor to position — and a caret that lives in the text is also what makes
 * the cursor assertable in a test, where a hardware cursor is not.
 */
function caretInto(text: string, cursorCol: number | undefined): string {
  if (cursorCol === undefined) return text;
  const padded = text.length > cursorCol ? text : text.padEnd(cursorCol + 1, " ");
  return `${padded.slice(0, cursorCol)}█${padded.slice(cursorCol + 1)}`;
}
