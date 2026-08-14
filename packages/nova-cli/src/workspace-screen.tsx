/** @jsxImportSource @termuijs/jsx */
import { useInput, useInterval, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import {
  applyAction,
  composeFrame,
  keyToAction,
  type WorkspaceSnapshot,
} from "./workspace-model";

/**
 * The control panel, drawn.
 *
 * This is the one place in Nova that owns a screen instead of appending to a transcript, and it is
 * built on TermUI (https://www.termui.io) rather than by hand for a specific reason: several live
 * panes updating independently is what a screen buffer is *for*, and it is exactly what an
 * append-only scroll cannot express. A tab running one model against a remote sandbox and a tab
 * running another against this checkout both want to be visible at once, and neither wants to be
 * interleaved with the other into a single column of text.
 *
 * Everything *decided* is decided in `workspace-model.ts` — which pane, how far scrolled, what a
 * key means. This file only turns a snapshot into widgets. That split is what lets the panel's
 * behaviour be tested by comparing values rather than by reading frames back, and it is what keeps
 * the framework replaceable: a 0.1.x dependency drawing the headline feature is a risk worth
 * confining to one file.
 *
 * Note the JSX pragma above. The repository's `tsconfig.json` points JSX at React for the web app;
 * a per-file pragma is what lets this one file use a different runtime without either of them
 * needing to know the other exists.
 */

/**
 * TermUI's widgets are classes that its JSX runtime also accepts as components. At 0.1.x only the
 * class side is typed, so used as elements they type-check against `Partial<Style>` and reject
 * `children`. The runtime is fine — `workspace-screen.test.tsx` renders these and reads the frame
 * back — so the aliases below describe what they actually are when written as elements, in one
 * place, rather than scattering suppressions through the tree.
 */
type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

/** What `useInput` hands a handler: the key's name under `key`, plus the modifier flags. */
type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

export type WorkspaceProps = {
  /**
   * The session, re-read every frame.
   *
   * A function rather than a value: a tab that prints while the panel is open has to appear, and
   * polling the session is far simpler to reason about than making every writer notify a screen
   * that may or may not be mounted.
   */
  read: () => WorkspaceSnapshot;
  onExit: () => void;
  /** How often to re-read. 200ms is under the threshold where a person calls a panel "live". */
  refreshMs?: number;
};

export function Workspace({ read, onExit, refreshMs = 200 }: WorkspaceProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => read());

  // The session is the source of truth for *content*; the panel owns only the view state, so a
  // refresh must not throw away which pane you are looking at or how far back you have scrolled.
  useInterval(() => {
    setSnapshot((current) => ({ ...read(), selected: current.selected, scroll: current.scroll }));
  }, refreshMs);

  // TermUI reports the key name as `key.key`; `workspace-model` speaks readline's `name`. Adapting
  // at the boundary keeps the model's vocabulary — and its tests — independent of the framework
  // that happens to be feeding it.
  useInput((input: string, key: TermUIKey) => {
    const action = keyToAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input);
    if (action.kind === "exit") { onExit(); return; }
    setSnapshot((current) => applyAction(current, action));
  });

  // One flat list of rows, already sized to the window. Composing the frame ourselves rather than
  // letting the layout engine distribute sections is what fixed the legend appearing in the middle
  // of a pane: independently sized boxes overlapped as soon as a pane held more lines than fitted.
  const rows = composeFrame(snapshot);

  return (
    <Panel flexDirection="column" width={snapshot.columns} height={snapshot.rows}>
      {rows.map((row, index) => (
        <Line key={`row-${index}`} bold={row.bold} dimColor={row.dim} inverse={row.inverse} color={row.color}>
          {row.text}
        </Line>
      ))}
    </Panel>
  );
}

export type WorkspaceHost = {
  read: () => WorkspaceSnapshot;
  onExit?: () => void;
};

/**
 * Opens the panel and resolves when the user leaves it.
 *
 * Both TermUI imports are dynamic. That is what keeps the framework's ~37 ms of load time off
 * `nova --version` and every other invocation that never draws a screen — the dependency is
 * declared and installed, and paid for at the moment somebody actually asks for a workspace.
 */
export async function runWorkspace(host: WorkspaceHost): Promise<void> {
  const { renderApp } = await import("@termuijs/jsx");
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      host.onExit?.();
      resolve();
    };
    void renderApp(Workspace as never, {
      read: host.read,
      onExit: finish,
      fullscreen: true,
    } as never).catch(finish);
  });
}
