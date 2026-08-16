import { windowStart } from "./chooser";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { visibleWidth } from "./markdown";
import { NO_COLOR_PALETTE, type Palette } from "./theme";
import { joinHorizontal, paginator, padToWidth as pad } from "./tui";

/**
 * The project, as something you look around in rather than type paths into.
 *
 * Nova already completes `@path` mentions from a flat file list — real, but blind: typing `@ap` and
 * seeing three candidates never tells you there is a fourth folder called `api` you haven't opened
 * yet. This is the third full-screen surface, on the same terms as the guide and the workspace
 * panel: a pure function of state decides everything, and only the finished rows become widgets.
 *
 * Directories first, alphabetically, same as `ls` with folders pinned to the top — the ordering a
 * project's own structure already implies, not a ranking this file invents.
 */

export type FileNode = {
  name: string;
  /** Root-relative, forward-slashed — the same shape `workspace.glob` returns. */
  path: string;
  kind: "dir" | "file";
  children: FileNode[];
};

/** Builds the tree from a flat file list — the shape `workspace.glob("**\/*")` already returns. */
export function buildFileTree(paths: readonly string[]): FileNode[] {
  const root: FileNode = { name: "", path: "", kind: "dir", children: [] };
  for (const raw of paths) {
    const parts = raw.split("/").filter((part) => part.length > 0);
    let node = root;
    let built = "";
    for (const [index, part] of parts.entries()) {
      built = built ? `${built}/${part}` : part;
      const isFile = index === parts.length - 1;
      let child = node.children.find((candidate) => candidate.name === part);
      if (!child) {
        child = { name: part, path: built, kind: isFile ? "file" : "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  sortTree(root);
  return root.children;
}

function sortTree(node: FileNode): void {
  node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  for (const child of node.children) sortTree(child);
}

/** How many files and folders a directory holds, directly or nested — a synchronous preview for a row with no content of its own to show. */
export function directorySummary(node: FileNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const child of node.children) {
    if (child.kind === "file") files += 1;
    else { dirs += 1; const nested = directorySummary(child); files += nested.files; dirs += nested.dirs; }
  }
  return { files, dirs };
}

export type FileRow = { node: FileNode; depth: number };

/** The tree, flattened to what expansion state makes visible — collapsed folders hide their children. */
export function flattenTree(tree: readonly FileNode[], expanded: ReadonlySet<string>, depth = 0): FileRow[] {
  const rows: FileRow[] = [];
  for (const node of tree) {
    rows.push({ node, depth });
    if (node.kind === "dir" && expanded.has(node.path)) rows.push(...flattenTree(node.children, expanded, depth + 1));
  }
  return rows;
}

/** Every file whose path matches, flat — searching abandons the tree shape the way `fzf` does, because a match three folders deep is not made easier to see by nesting it three folders deep. */
export function filterTree(tree: readonly FileNode[], query: string): FileRow[] {
  const needle = query.toLowerCase();
  const rows: FileRow[] = [];
  const walk = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "file") { if (node.path.toLowerCase().includes(needle)) rows.push({ node, depth: 0 }); }
      else walk(node.children);
    }
  };
  walk(tree);
  return rows;
}

export type FileBrowserState = {
  tree: readonly FileNode[];
  /** Paths of expanded directories. */
  expanded: ReadonlySet<string>;
  /** Index into the *visible* rows. */
  selected: number;
  query: string;
  searching: boolean;
  columns: number;
  rows: number;
  palette: Palette;
};

export function initialFileBrowserState(paths: readonly string[], columns: number, rows: number, palette: Palette = NO_COLOR_PALETTE): FileBrowserState {
  return { tree: buildFileTree(paths), expanded: new Set(), selected: 0, query: "", searching: false, columns, rows, palette };
}

/** The rows on screen right now: a flat filtered list while searching, the expanded tree otherwise. */
export function visibleRows(state: FileBrowserState): FileRow[] {
  return state.query ? filterTree(state.tree, state.query) : flattenTree(state.tree, state.expanded);
}

export function currentRow(state: FileBrowserState): FileRow | undefined {
  const rows = visibleRows(state);
  if (rows.length === 0) return undefined;
  return rows[Math.max(0, Math.min(state.selected, rows.length - 1))];
}

export type FileBrowserAction =
  | { kind: "move"; step: number }
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "search" }
  | { kind: "type"; character: string }
  | { kind: "backspace" }
  | { kind: "commit" }
  | { kind: "exit" }
  | { kind: "pick" }
  | { kind: "none" };

/**
 * What a key does. Two modes, same split the guide uses: while searching, every printable key is
 * text, so typing "read" filters instead of firing four navigation shortcuts.
 */
export function keyToFileAction(key: { name?: string; ctrl?: boolean; shift?: boolean }, character: string | undefined, searching: boolean): FileBrowserAction {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { kind: "exit" };
  const isEnter = name === "return" || name === "enter" || name === "\r" || name === "\n";
  const isEscape = name === "escape" || name === "\x1b";

  if (searching) {
    if (isEscape) return { kind: "commit" };
    if (isEnter) return { kind: "pick" };
    if (name === "backspace") return { kind: "backspace" };
    if (name === "up") return { kind: "move", step: -1 };
    if (name === "down") return { kind: "move", step: 1 };
    if (character && character.length === 1 && character >= " ") return { kind: "type", character };
    return { kind: "none" };
  }

  if (isEscape || name === "q") return { kind: "exit" };
  if (character === "/") return { kind: "search" };
  if (isEnter) return { kind: "pick" };
  if (name === "up" || name === "k") return { kind: "move", step: -1 };
  if (name === "down" || name === "j") return { kind: "move", step: 1 };
  if (name === "right" || name === "l") return { kind: "expand" };
  if (name === "left" || name === "h") return { kind: "collapse" };
  return { kind: "none" };
}

export function applyFileAction(state: FileBrowserState, action: FileBrowserAction): FileBrowserState {
  const rows = visibleRows(state);
  switch (action.kind) {
    case "move": {
      if (rows.length === 0) return state;
      const next = (((state.selected + action.step) % rows.length) + rows.length) % rows.length;
      return { ...state, selected: next };
    }
    case "expand": {
      const row = currentRow(state);
      if (!row || row.node.kind !== "dir" || state.expanded.has(row.node.path)) return state;
      return { ...state, expanded: new Set([...state.expanded, row.node.path]) };
    }
    case "collapse": {
      const row = currentRow(state);
      if (!row || row.node.kind !== "dir" || !state.expanded.has(row.node.path)) return state;
      const expanded = new Set(state.expanded);
      expanded.delete(row.node.path);
      return { ...state, expanded };
    }
    case "search":
      return { ...state, searching: true };
    case "commit":
      return { ...state, searching: false };
    case "backspace":
      return { ...state, query: state.query.slice(0, -1), selected: 0 };
    case "type":
      return { ...state, query: state.query + action.character, selected: 0 };
    default:
      return state;
  }
}

/** `expand`/`collapse` toggled by whichever a directory currently needs — what Enter and `l`/`h` on a folder both mean. */
export function toggleDirectory(state: FileBrowserState): FileBrowserState {
  const row = currentRow(state);
  if (!row || row.node.kind !== "dir") return state;
  return applyFileAction(state, state.expanded.has(row.node.path) ? { kind: "collapse" } : { kind: "expand" });
}

export type FileRowStyle = { text: string; bold?: boolean; dim?: boolean; inverse?: boolean; color?: string };

/** Width of the tree pane. Dropped entirely below 40 columns — there is no room left for a preview once it takes its share. */
export function treeWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return width < 40 ? width : Math.max(20, Math.floor(width * 0.4));
}

export function previewWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return width < 40 ? 0 : Math.max(1, width - treeWidth(width) - 3);
}

/** Rows of body available once the header and footer have taken one each. */
export function bodyHeight(rows: number): number {
  return Math.max(0, Math.floor(rows) - 2);
}

/** One tree row's label: indentation, a disclosure triangle for a folder, the name, a trailing slash for a folder. */
export function treeLabel(row: FileRow, expanded: ReadonlySet<string>, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const indent = "  ".repeat(row.depth);
  if (row.node.kind === "file") return `${indent}  ${row.node.name}`;
  const triangle = expanded.has(row.node.path) ? glyphs.expanded : glyphs.collapsed;
  return `${indent}${triangle} ${row.node.name}/`;
}

export type FilePreview =
  | { kind: "directory"; files: number; dirs: number }
  | { kind: "file"; lines: readonly string[]; totalLines: number; truncated: boolean }
  | { kind: "error"; message: string }
  | { kind: "empty" };

/**
 * The whole screen, row by row, exactly `rows` tall — composed as strings for the reason the guide
 * and the workspace panel are: independently sized boxes overlap the moment either one outgrows the
 * space a layout engine gave it, and string arithmetic makes that impossible.
 *
 * `preview` arrives from the caller rather than living in state: a directory's summary is free to
 * compute here, but a file's contents are an async read the pure reducer above has no business
 * doing, so the screen component owns fetching it and hands back whatever it currently has.
 */
export function composeFileFrame(state: FileBrowserState, preview: FilePreview, glyphs: GlyphSet = UNICODE_GLYPHS): FileRowStyle[] {
  const columns = Math.max(1, Math.floor(state.columns));
  const rowCount = Math.max(1, Math.floor(state.rows));
  const height = bodyHeight(rowCount);
  const rows = visibleRows(state);
  const selectedIndex = rows.length === 0 ? -1 : Math.max(0, Math.min(state.selected, rows.length - 1));
  const showPreview = previewWidth(columns) > 0;
  const tree = showPreview ? treeWidth(columns) : columns;
  const body = previewWidth(columns);
  const theme = state.palette.tokens;

  const out: FileRowStyle[] = [];
  const current = selectedIndex === -1 ? undefined : rows[selectedIndex];
  out.push({ text: pad(` nova files · ${current ? current.node.path : "no matches"}`, columns), bold: true, color: theme.primary });
  if (rowCount === 1) return out;

  const start = windowStart(selectedIndex < 0 ? 0 : selectedIndex, rows.length, height);
  const previewLines = previewToLines(preview, body);
  for (let offset = 0; offset < height; offset += 1) {
    const row = rows[start + offset];
    const chosen = row !== undefined && start + offset === selectedIndex;
    const label = row ? treeLabel(row, state.expanded, glyphs) : "";
    const treeCell = pad(chosen ? `${glyphs.prompt} ${label}` : `  ${label}`, tree);
    out.push({
      text: showPreview
        ? joinHorizontal(treeCell, previewLines[offset] ?? "", { leftWidth: tree, rightWidth: body, separator: ` ${glyphs.boxVertical} ` })
        : treeCell,
      bold: chosen,
      dim: row?.node.kind === "dir" && !chosen,
      color: chosen ? theme.accent : undefined,
    });
  }

  const overflow = rows.length > height ? `  ${paginator(selectedIndex < 0 ? 0 : selectedIndex, rows.length)}` : "";
  const footer = state.searching
    ? `search: ${state.query}▏  Enter open · Esc done`
    : `↑↓ move · →/l open · ←/h close · Enter pick a file · / search · q leave${state.query ? `   filter: ${state.query}` : ""}${overflow}`;
  out.push({ text: pad(` ${footer}`, columns), dim: true, color: theme.textMuted });
  return out;
}

function previewToLines(preview: FilePreview, width: number): string[] {
  if (width <= 0) return [];
  switch (preview.kind) {
    case "empty":
      return ["", "  (nothing to preview)"];
    case "error":
      return ["", `  ${preview.message}`];
    case "directory":
      return ["", `  ${preview.dirs} folder${preview.dirs === 1 ? "" : "s"}, ${preview.files} file${preview.files === 1 ? "" : "s"}`];
    case "file": {
      const lines = preview.lines.map((line) => `  ${line}`);
      if (preview.truncated) lines.push("", `  … ${preview.totalLines} lines total`);
      return lines;
    }
  }
}
