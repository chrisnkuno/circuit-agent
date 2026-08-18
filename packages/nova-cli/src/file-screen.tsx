/** @jsxImportSource @termuijs/jsx */
import { useAsync, useInput, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import {
  applyFileAction,
  composeFileFrame,
  currentRow,
  directorySummary,
  initialFileBrowserState,
  keyToFileAction,
  toggleDirectory,
  type FileBrowserState,
  type FilePreview,
} from "./file-browser";
import { NO_COLOR_PALETTE, type Palette } from "./theme";

/**
 * The project tree, as a screen you look around in.
 *
 * Built exactly like the guide and the workspace panel: `file-browser.ts` decides everything about
 * navigation and layout, and this file turns the finished rows into widgets plus the one thing a
 * pure module has no business doing — fetching a file's contents once it is selected.
 */

type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

/** What the caller reads a file with — a workspace's `readFile`, or anything shaped like it. */
export type FileReader = (path: string) => Promise<{ content: string; totalLines: number; truncated: boolean }>;

export type FileScreenProps = {
  columns: number;
  rows: number;
  /** Root-relative, forward-slashed — the same shape `workspace.glob` returns. */
  paths: readonly string[];
  /** The path picked, or undefined if the reader left without choosing one. */
  onExit: (picked: FileScreenChoice | undefined) => void;
  palette?: Palette;
  readFile: FileReader;
};

export function FileScreen({ columns, rows, paths, onExit, palette = NO_COLOR_PALETTE, readFile }: FileScreenProps) {
  const [state, setState] = useState<FileBrowserState>(() => initialFileBrowserState(paths, columns, rows, palette));
  const selected = currentRow(state);
  // Keyed on the path, not the row index: two different selections can land on the same index
  // (one row collapses, another takes its place) and would otherwise share a stale fetch.
  const previewPath = selected?.node.kind === "file" ? selected.node.path : undefined;

  const { data, error } = useAsync(async () => (previewPath ? readFile(previewPath) : null), [previewPath]);

  const preview: FilePreview = !selected
    ? { kind: "empty" }
    : selected.node.kind === "dir"
      ? { kind: "directory", ...directorySummary(selected.node) }
      : error
        ? { kind: "error", message: error.message }
        : data
          ? { kind: "file", lines: data.content.split("\n"), totalLines: data.totalLines, truncated: data.truncated }
          : { kind: "empty" };

  useInput((input: string, key: TermUIKey) => {
    const action = keyToFileAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input, state.searching);
    if (action.kind === "exit") { onExit(undefined); return; }
    if (action.kind === "pick" || action.kind === "edit") {
      const current = currentRow(state);
      // Both keys land on a file the same way; only the intent differs, and the caller decides what
      // to do with it. A directory has nothing to edit, so `e` falls through to expanding it.
      if (current?.node.kind === "file") { onExit({ path: current.node.path, intent: action.kind === "edit" ? "edit" : "mention" }); return; }
      setState((value) => toggleDirectory(value));
      return;
    }
    setState((current) => applyFileAction(current, action));
  });

  const frame = composeFileFrame(state, preview);

  return (
    <Panel flexDirection="column" width={state.columns} height={state.rows}>
      {frame.map((line, index) => (
        <Line key={`row-${index}`} bold={line.bold} dimColor={line.dim} inverse={line.inverse} color={line.color}>
          {line.text}
        </Line>
      ))}
    </Panel>
  );
}

/**
 * What the reader chose, and what they meant by it.
 *
 * Enter and `e` both select a file; they differ only in intent — one is "put this in my message",
 * the other is "open it". Returning the intent rather than two different screens keeps one browser
 * with one set of keys, and leaves the decision with the caller that knows what it can offer.
 */
export type FileScreenChoice = { path: string; intent: "mention" | "edit" };

/**
 * Opens the picker and resolves with whichever file was chosen, or undefined if the reader left
 * without picking one. TermUI is imported dynamically, so a session that never opens this pays
 * nothing for it — the same arrangement the guide and the control panel use.
 */
export async function runFileScreen(options: {
  columns: number;
  rows: number;
  paths: readonly string[];
  palette?: Palette;
  readFile: FileReader;
}): Promise<FileScreenChoice | undefined> {
  const { renderApp } = await import("@termuijs/jsx");
  return new Promise<FileScreenChoice | undefined>((resolve) => {
    let settled = false;
    const finish = (picked: FileScreenChoice | undefined) => {
      if (settled) return;
      settled = true;
      resolve(picked);
    };
    void renderApp(FileScreen as never, {
      columns: options.columns,
      rows: options.rows,
      paths: options.paths,
      palette: options.palette,
      readFile: options.readFile,
      onExit: finish,
      fullscreen: true,
    } as never).catch(() => finish(undefined));
  });
}
