import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { clipTo, terminalColumns, windowStart } from "./chooser";
import { visibleWidth } from "./markdown";
import type { KeypressEvent } from "./keybindings";
import type { ModelCatalog, ModelChoice } from "./models";
import type { ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";

/**
 * Choosing a model by moving to it, rather than by naming it.
 *
 * `/model` could already list and switch, but both halves asked the user to carry something: the
 * numbered list asked them to read a number and then type it somewhere else, and the typed form
 * asked them to know the id. Neither is hard; both are a step between deciding and doing that a
 * cursor and Return remove entirely.
 *
 * The other thing a menu can do that a printed list cannot is *lead somewhere*. A provider with no
 * key is the most common reason the list is short, and printing "set OPENAI_API_KEY" leaves the
 * person holding a task. Here that line is a row you can select, and selecting it opens settings —
 * the dead end becomes the fix.
 */

export type PickerRow =
  | { kind: "model"; choice: ModelChoice; header?: string }
  /** Selecting this leaves the picker and opens the settings menu. */
  | { kind: "settings"; label: string; header?: string };

export type PickerResult =
  | { kind: "model"; choice: ModelChoice }
  | { kind: "settings" };

export type PickerState = { selected: number };

/**
 * The rows, in the order they are shown: what you can switch to, then what you could fix.
 *
 * Unconfigured providers come after the usable models deliberately. They are the more interesting
 * rows to someone setting up and the less interesting to everyone else, and the list is opened to
 * switch models far more often than to add a key.
 */
export function buildPickerRows(catalog: ModelCatalog): PickerRow[] {
  const rows: PickerRow[] = [];
  let lastProvider: ProviderId | null = null;
  for (const choice of catalog.choices) {
    const header = choice.provider === lastProvider ? undefined : choice.providerLabel;
    lastProvider = choice.provider;
    rows.push({ kind: "model", choice, ...(header ? { header } : {}) });
  }
  for (const entry of catalog.unconfigured) {
    rows.push({ kind: "settings", header: entry.label, label: `Add a key — needs ${entry.missing.join(" and ")}` });
  }
  rows.push({ kind: "settings", header: "Settings", label: "Keys, models, pricing and voice…" });
  return rows;
}

/** Where the cursor starts: on the model in use, so the common case is "look, then Escape". */
export function initialSelection(rows: readonly PickerRow[], current: { provider: ProviderId; model: string }): number {
  const index = rows.findIndex((row) => row.kind === "model" && row.choice.provider === current.provider && row.choice.model === current.model);
  return index >= 0 ? index : 0;
}

export type PickerPaint = {
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
};

export type RenderPickerOptions = {
  /** Terminal columns. Rows are clipped to it; a wrapped row corrupts the repaint. */
  width?: number;
  /** Visible rows before the list scrolls under the selection. */
  height?: number;
  /** Characters this terminal can draw; the cursor, the current-model dot and the legend come from here. */
  glyphs?: GlyphSet;
  current: { provider: ProviderId; model: string };
  price: (choice: ModelChoice) => string;
  paint: PickerPaint;
};

export function renderModelPicker(frame: { rows: readonly PickerRow[]; selected: number }, options: RenderPickerOptions): string {
  const { paint } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const height = options.height ?? 10;
  // Same windowing rule as the palette: keep the selection on screen, or the arrow keys look broken.
  const columns = terminalColumns(options.width);
  const start = windowStart(frame.selected, frame.rows.length, height);
  const visible = frame.rows.slice(start, start + height);
  const naturalWidth = Math.max(0, ...visible.map((row) => visibleWidth(row.kind === "model" ? row.choice.model : row.label)));
  const labelBudget = Math.max(0, Math.min(naturalWidth, Math.floor(Math.max(0, columns - 11) * 0.65)));

  const lines: string[] = [];
  for (const [offset, row] of visible.entries()) {
    if (row.header) lines.push(paint.cyan(clipTo(`  ${row.header}`, columns)));
    const active = start + offset === frame.selected;
    const cursor = active ? paint.green(glyphs.prompt) : " ";
    const number = offset < 9 ? `${offset + 1}.` : "  ";
    if (columns < 9) {
      const label = row.kind === "model" ? row.choice.model : row.label;
      lines.push(active ? paint.green(clipTo(`${glyphs.prompt}${label}`, columns)) : clipTo(label, columns));
      continue;
    }
    if (row.kind === "settings") {
      lines.push(`  ${cursor} ${paint.dim(number)} ${paint.yellow(clipTo(row.label, columns - 7))}`);
      continue;
    }
    const isCurrent = row.choice.provider === options.current.provider && row.choice.model === options.current.model;
    const tags = [row.choice.isProviderDefault ? "default" : "", isCurrent ? "current" : ""].filter(Boolean).join(", ");
    const shownModel = clipTo(row.choice.model, labelBudget);
    const padded = shownModel + " ".repeat(Math.max(0, labelBudget - visibleWidth(shownModel)));
    const tail = `${options.price(row.choice)}${tags ? `  (${tags})` : ""}`;
    const room = Math.max(0, columns - visibleWidth(`  ${active ? glyphs.prompt : " "} ${number} ${isCurrent ? glyphs.circleFull : " "} ${padded}  `));
    lines.push(`  ${cursor} ${paint.dim(number)} ${isCurrent ? paint.green(glyphs.circleFull) : " "} ${padded}  ${paint.dim(clipTo(tail, room))}`);
  }
  lines.push(paint.dim(clipTo(`  ${glyphs.arrowUp}${glyphs.arrowDown} move ${glyphs.middot} Enter choose ${glyphs.middot} Esc cancel`, columns)));
  return lines.join("\n");
}

/**
 * Advances the picker one keystroke.
 *
 * Split from the reading loop for the same reason the palette's is: the whole interaction is then
 * testable without a terminal, and the loop below does nothing but turn keypresses into these calls.
 */
export function advanceModelPicker(state: PickerState, rows: readonly PickerRow[], input: { str?: string; key: KeypressEvent }, options: { height?: number } = {}): {
  state: PickerState;
  done?: { result?: PickerResult };
} {
  const name = input.key.name;
  const last = Math.max(0, rows.length - 1);

  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) return { state, done: {} };
  if (name === "return" || name === "enter") {
    const row = rows.length > 0 ? rows[Math.max(0, Math.min(state.selected, rows.length - 1))] : undefined;
    if (!row) return { state, done: {} };
    return { state, done: { result: row.kind === "model" ? { kind: "model", choice: row.choice } : { kind: "settings" } } };
  }
  // Clamped rather than wrapped: wrapping past the end of a list this short reads as the cursor
  // having jumped somewhere at random.
  if (name === "up" || (input.key.ctrl && name === "p")) return { state: { selected: Math.max(0, state.selected - 1) } };
  if (name === "down" || (input.key.ctrl && name === "n")) return { state: { selected: Math.min(last, state.selected + 1) } };
  if (name === "home") return { state: { selected: 0 } };
  if (name === "end") return { state: { selected: last } };

  // Typing a number still works, because the printed list taught people to do that and a menu that
  // silently ignores the habit it created is worse than one that never offered numbers at all.
  if (input.str && /^[1-9]$/.test(input.str) && !input.key.ctrl && !input.key.meta) {
    const height = options.height ?? 10;
    const start = windowStart(state.selected, rows.length, height);
    const shown = Math.min(height, rows.length - start);
    const digit = Number(input.str);
    if (digit > shown) return { state };
    return { state: { selected: start + digit - 1 } };
  }
  return { state };
}

export type RunModelPickerOptions = RenderPickerOptions & {
  rows: readonly PickerRow[];
  /** Re-read before every frame so a live terminal resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
};

export async function runModelPicker(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  paint: (frame: string) => void,
  options: RunModelPickerOptions,
): Promise<PickerResult | undefined> {
  const { rows } = options;
  let state: PickerState = { selected: initialSelection(rows, options.current) };
  const liveOptions = (): RunModelPickerOptions => {
    const size = options.getSize?.();
    const height = Math.max(1, Math.min(options.height ?? 10, size?.height ?? Number.POSITIVE_INFINITY));
    return { ...options, width: size?.width ?? options.width, height };
  };
  paint(renderModelPicker({ rows, selected: state.selected }, liveOptions()));

  for await (const input of keys) {
    const current = liveOptions();
    const step = advanceModelPicker(state, rows, input, { height: current.height });
    state = step.state;
    if (step.done) return step.done.result;
    paint(renderModelPicker({ rows, selected: state.selected }, liveOptions()));
  }
  return undefined;
}
