/** @jsxImportSource @termuijs/jsx */
import { useInput, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import {
  applyGuideAction,
  composeGuideFrame,
  initialGuideState,
  keyToGuideAction,
  type GuideBrowserState,
} from "./guide-browser";
import { NO_COLOR_PALETTE, type Palette } from "./theme";

/**
 * The guide, as a screen you read in.
 *
 * The second full-screen surface, built exactly like the first: `guide-browser.ts` decides
 * everything and this file only turns finished rows into widgets. Both screens now share that
 * shape, which means the framework is confined to two small files and the parts worth being sure
 * about — layout, navigation, what a key does — are checked by comparing strings.
 *
 * The printed forms (`/guide tabs`, `/guide all`) are deliberately kept. A screen is better for
 * reading and useless for quoting: a topic you want to keep, paste into an issue or pipe to a file
 * has to end up in the transcript, and a full-screen viewer cannot put it there.
 */

/**
 * TermUI's widgets are classes its JSX runtime also accepts as components; at 0.1.x only the class
 * side is typed, so as elements they reject `children`. Aliased once here, as in `workspace-screen`.
 */
type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

/** What `useInput` hands a handler: the key's name under `key`, plus the modifier flags. */
type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

export type GuideScreenProps = {
  columns: number;
  rows: number;
  onExit: () => void;
  /** Opens on this topic rather than the first — `/guide tabs` from the prompt lands on tabs. */
  startAt?: string;
  /** The session's theme, so the guide matches the transcript it was opened from. */
  palette?: Palette;
};

export function GuideScreen({ columns, rows, onExit, startAt, palette = NO_COLOR_PALETTE }: GuideScreenProps) {
  const [state, setState] = useState<GuideBrowserState>(() => {
    const initial = initialGuideState(columns, rows, palette);
    const index = startAt ? initial.topics.findIndex((topic) => topic.id === startAt) : -1;
    return index >= 0 ? { ...initial, selected: index } : initial;
  });

  useInput((input: string, key: TermUIKey) => {
    const action = keyToGuideAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input, state.searching);
    if (action.kind === "exit") { onExit(); return; }
    setState((current) => applyGuideAction(current, action));
  });

  const frame = composeGuideFrame(state);

  return (
    <Panel flexDirection="column" width={state.columns} height={state.rows}>
      {frame.map((row, index) => (
        <Line key={`row-${index}`} bold={row.bold} dimColor={row.dim} inverse={row.inverse} color={row.color}>
          {row.text}
        </Line>
      ))}
    </Panel>
  );
}

/**
 * Opens the guide and resolves when the reader leaves.
 *
 * TermUI is imported dynamically, so a session that never opens the guide never pays to load it —
 * the same arrangement the control panel uses, and the reason `nova --version` is unaffected by
 * either of them existing.
 */
export async function runGuideScreen(options: { columns: number; rows: number; startAt?: string; palette?: Palette }): Promise<void> {
  const { renderApp } = await import("@termuijs/jsx");
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    void renderApp(GuideScreen as never, {
      columns: options.columns,
      rows: options.rows,
      startAt: options.startAt,
      palette: options.palette,
      onExit: finish,
      fullscreen: true,
    } as never).catch(finish);
  });
}
