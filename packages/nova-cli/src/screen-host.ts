/**
 * Opening a full-screen view, and giving the terminal back.
 *
 * Both screens need the same six steps in the same order, and getting one wrong is invisible until
 * a user is stuck in a dead prompt. They live here once:
 *
 *   1. refuse when there is no terminal to draw on
 *   2. load the framework, and fall back rather than fail when it is not there
 *   3. take the terminal — status bar down, pinned region released, shortcuts uninstalled,
 *      readline paused
 *   4. run
 *   5. give it back, in a `finally`, whatever happened
 *   6. redraw what the transcript had
 *
 * Step 3's ordering matters. The framework takes stdin for itself, so shortcuts must be
 * *reinstalled* afterwards rather than merely re-enabled: the listeners they registered are torn
 * down by the framework on the way in and never restored on the way out.
 *
 * See `docs/reference/terminal-design-system.md` §10.
 */

export type ScreenCapabilities = {
  /** A real terminal, not a pipe or a `--json` run. */
  interactive: boolean;
  columns: number;
  rows: number;
};

export type ScreenReason = "not-interactive" | "framework-missing" | "too-small";

export type ScreenOutcome =
  | { ok: true }
  | { ok: false; reason: ScreenReason; detail?: string };

/** Terminals below this cannot hold a header, a body row and a legend without lying about it. */
export const MINIMUM_SCREEN = { columns: 40, rows: 8 };

/**
 * Whether a screen can be drawn at all.
 *
 * Checked before the framework is loaded, so a piped run never pays 37 ms to be told it cannot have
 * a screen it was never going to use.
 */
export function canDrawScreen(capabilities: ScreenCapabilities): ScreenOutcome {
  if (!capabilities.interactive) return { ok: false, reason: "not-interactive" };
  if (capabilities.columns < MINIMUM_SCREEN.columns || capabilities.rows < MINIMUM_SCREEN.rows) {
    return {
      ok: false,
      reason: "too-small",
      detail: `needs at least ${MINIMUM_SCREEN.columns}×${MINIMUM_SCREEN.rows}, this terminal is ${capabilities.columns}×${capabilities.rows}`,
    };
  }
  return { ok: true };
}

/** One line saying why there is no screen, in terms of what the reader can do about it. */
export function explainScreenRefusal(outcome: Extract<ScreenOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case "not-interactive":
      return "This needs an interactive terminal.";
    case "too-small":
      return `This needs a bigger window — ${outcome.detail}.`;
    case "framework-missing":
      return `The screen could not be loaded${outcome.detail ? `: ${outcome.detail}` : ""}.`;
  }
}

export type TerminalControls = {
  /** Erase anything the transcript renderer has drawn below the cursor. */
  clearStatus(): void;
  /** Release the pinned scroll region, if one is held. */
  releaseScreen(): void;
  /** Remove the shortcut key listeners. */
  uninstallShortcuts(): void;
  /** Re-register them. Not the same as re-enabling: the framework tore the old ones down. */
  installShortcuts(): void;
  pauseInput(): void;
  resumeInput(): void;
  /** Re-establish the pinned region and redraw the idle status line. */
  restoreScreen(): void;
};

/**
 * Runs `open` with the terminal to itself, restoring everything afterwards.
 *
 * `open` is a thunk rather than a value so the framework import happens *inside* the try — a module
 * that throws while loading must still leave the terminal usable.
 */
export async function withFullScreen(
  capabilities: ScreenCapabilities,
  controls: TerminalControls,
  open: () => Promise<void>,
): Promise<ScreenOutcome> {
  const allowed = canDrawScreen(capabilities);
  if (!allowed.ok) return allowed;

  controls.clearStatus();
  controls.releaseScreen();
  controls.uninstallShortcuts();
  controls.pauseInput();
  try {
    await open();
    return { ok: true };
  } catch (error) {
    // A framework that fails to load or to mount is a missing screen, not a broken session: the
    // caller falls back to text and the terminal is handed back by the `finally` below.
    return { ok: false, reason: "framework-missing", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    controls.resumeInput();
    controls.installShortcuts();
    controls.restoreScreen();
  }
}
