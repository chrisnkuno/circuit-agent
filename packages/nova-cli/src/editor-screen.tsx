/** @jsxImportSource @termuijs/jsx */
import { useInput, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import {
  applyEditorAction,
  composeEditorFrame,
  editorContent,
  initialEditorState,
  keyToEditorAction,
  type EditorState,
} from "./editor";
import { NO_COLOR_PALETTE, type Palette } from "./theme";

/**
 * The editor, as a screen.
 *
 * Same split as `file-screen.tsx`: `editor.ts` owns every decision about what a key means and what
 * the document becomes, and this file does the two things a pure reducer cannot — turn rows into
 * widgets, and write the file when the reducer says to.
 */

type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

export type EditorScreenProps = {
  columns: number;
  rows: number;
  path: string;
  content: string;
  /** Reports the final content when it was saved, or undefined when the reader quit without saving. */
  onExit: (saved: string | undefined) => void;
  palette?: Palette;
};

/** Two rows of chrome — status above, key bar below — leaving the rest for text. */
const CHROME_ROWS = 2;

export function EditorScreen({ columns, rows, path, content, onExit, palette = NO_COLOR_PALETTE }: EditorScreenProps) {
  const [state, setState] = useState<EditorState>(() => initialEditorState(path, content, Math.max(1, rows - CHROME_ROWS)));

  useInput((input: string, key: TermUIKey) => {
    setState((current) => {
      const action = keyToEditorAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input, current);
      const { state: next, effect } = applyEditorAction(current, action);
      // The host writes on save and reports on quit. `quit` deliberately does not prompt about
      // unsaved changes here: the caller has the file on disk and the returned content, and is the
      // only layer that can ask a question and wait for an answer.
      if (effect?.kind === "save") onExit(editorContent(next));
      else if (effect?.kind === "quit") onExit(undefined);
      return next;
    });
  });

  const frame = composeEditorFrame(state, columns, palette.accent);

  return (
    <Panel flexDirection="column" width={columns} height={rows}>
      {frame.map((line, index) => (
        <Line key={`row-${index}`} bold={line.bold} dimColor={line.dim} color={line.color}>
          {line.text}
        </Line>
      ))}
    </Panel>
  );
}

/**
 * Opens the editor and resolves with the saved content, or undefined if it was closed unsaved.
 *
 * TermUI is imported dynamically so a session that never edits anything pays nothing for it — the
 * same arrangement the guide, the file picker and the control panel all use.
 */
export async function runEditorScreen(options: {
  columns: number;
  rows: number;
  path: string;
  content: string;
  palette?: Palette;
}): Promise<string | undefined> {
  const { renderApp } = await import("@termuijs/jsx");
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (saved: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(saved);
    };
    void renderApp(EditorScreen as never, {
      columns: options.columns,
      rows: options.rows,
      path: options.path,
      content: options.content,
      palette: options.palette,
      onExit: finish,
      fullscreen: true,
    } as never).catch(() => finish(undefined));
  });
}
