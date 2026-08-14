import { describe, expect, it } from "vitest";
import { advanceModelPicker, buildPickerRows, initialSelection, renderModelPicker, runModelPicker, type PickerRow } from "./model-picker";
import { buildModelCatalog } from "./models";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";

const paint = { dim: (text: string) => text, cyan: (text: string) => text, green: (text: string) => text, yellow: (text: string) => text };
const configured = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" };
const current = { provider: "anthropic" as const, model: "claude-sonnet-5" };
const options = { current, price: () => "$2/$10 per Mtok", paint };

const press = (name: string, key: Partial<KeypressEvent> = {}, str?: string) => ({ ...(str === undefined ? {} : { str }), key: { name, ...key } as KeypressEvent });

describe("the picker's rows", () => {
  it("offers every switchable model, then a way to fix what is missing", () => {
    const rows = buildPickerRows(buildModelCatalog({ ANTHROPIC_API_KEY: "k" }, "2026-08-10"));
    const models = rows.filter((row) => row.kind === "model");
    const settings = rows.filter((row) => row.kind === "settings");

    expect(models.length).toBeGreaterThan(0);
    // Two unconfigured providers, plus the general settings row.
    expect(settings).toHaveLength(3);
    expect(rows.at(-1)).toMatchObject({ kind: "settings" });
  });

  it("makes an unconfigured provider a row you can act on, not a note to go elsewhere", () => {
    const rows = buildPickerRows(buildModelCatalog({ ANTHROPIC_API_KEY: "k" }, "2026-08-10"));
    const openai = rows.find((row) => row.header === "OpenAI");
    expect(openai).toMatchObject({ kind: "settings" });
    if (openai?.kind !== "settings") throw new Error("expected a settings row");
    expect(openai.label).toContain("OPENAI_API_KEY");
  });

  it("heads each provider's group once, so the list reads as groups rather than a flat wall", () => {
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    expect(rows.filter((row) => row.header === "Anthropic")).toHaveLength(1);
  });

  it("starts the cursor on the model in use", () => {
    // The common case is opening the list to look, so the cursor should already be where the
    // answer to "what am I on?" is.
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    const start = initialSelection(rows, current);
    expect(rows[start]).toMatchObject({ kind: "model", choice: { model: "claude-sonnet-5" } });
  });

  it("falls back to the first row when the current model is not in the list", () => {
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    expect(initialSelection(rows, { provider: "anthropic", model: "not-a-model" })).toBe(0);
  });
});

describe("moving around the picker", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("moves with the arrows and clamps at both ends", () => {
    // Wrapping past the end of a short list reads as the cursor jumping somewhere at random.
    expect(advanceModelPicker({ selected: 0 }, rows, press("up")).state.selected).toBe(0);
    expect(advanceModelPicker({ selected: 0 }, rows, press("down")).state.selected).toBe(1);
    expect(advanceModelPicker({ selected: rows.length - 1 }, rows, press("down")).state.selected).toBe(rows.length - 1);
  });

  it("still accepts a typed number, the habit the printed list taught", () => {
    expect(advanceModelPicker({ selected: 0 }, rows, press("3", {}, "3")).state.selected).toBe(2);
  });

  it("interprets a number against the visible window after scrolling", () => {
    const selected = rows.length - 1;
    const height = 4;
    const rendered = renderModelPicker({ rows, selected }, { ...options, height });
    const first = rendered.split("\n").find((line) => line.includes("1."));
    const jumped = advanceModelPicker({ selected }, rows, press("1", {}, "1"), { height }).state.selected;
    const label = rows[jumped]?.kind === "model" ? rows[jumped].choice.model : rows[jumped]?.label;
    expect(first).toContain(label);
  });

  it("ignores a number past the end of the list", () => {
    const short: PickerRow[] = [{ kind: "settings", label: "Settings…" }];
    expect(advanceModelPicker({ selected: 0 }, short, press("9", {}, "9")).state.selected).toBe(0);
  });

  it("ignores a number the live window never displayed", () => {
    expect(advanceModelPicker({ selected: 0 }, rows, press("9", {}, "9"), { height: 4 }).state.selected).toBe(0);
  });

  it("returns the chosen model on Return", () => {
    const done = advanceModelPicker({ selected: 0 }, rows, press("return")).done;
    expect(done?.result).toMatchObject({ kind: "model", choice: { model: "claude-sonnet-5" } });
  });

  it("clamps a stale selection when Enter uses it", () => {
    const done = advanceModelPicker({ selected: rows.length + 20 }, rows, press("return")).done;
    expect(done?.result).toEqual({ kind: "settings" });
  });

  it("returns a request to open settings when a settings row is chosen", () => {
    const done = advanceModelPicker({ selected: rows.length - 1 }, rows, press("return")).done;
    expect(done?.result).toEqual({ kind: "settings" });
  });

  it("cancels on Escape and Ctrl-C, choosing nothing", () => {
    expect(advanceModelPicker({ selected: 2 }, rows, press("escape")).done).toEqual({});
    expect(advanceModelPicker({ selected: 2 }, rows, press("c", { ctrl: true })).done).toEqual({});
  });
});

describe("rendering the picker", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("marks the cursor and the model in use, and prices each row", () => {
    const rendered = renderModelPicker({ rows, selected: initialSelection(rows, current) }, options);
    expect(rendered).toContain("❯");
    expect(rendered).toContain("claude-sonnet-5");
    expect(rendered).toContain("per Mtok");
    expect(rendered).toContain("current");
  });

  it("keeps the selection on screen in a list longer than the window", () => {
    const rendered = renderModelPicker({ rows, selected: rows.length - 1 }, { ...options, height: 4 });
    expect(rendered).toContain("❯");
  });

  it("says how to drive it, since a menu that needs explaining elsewhere is not finished", () => {
    expect(renderModelPicker({ rows, selected: 0 }, options)).toContain("Esc");
  });

  it("shows the same window-relative number the key handler accepts", () => {
    expect(renderModelPicker({ rows, selected: 0 }, options)).toContain("1.");
  });

  it("clips long model ids, prices and settings rows at every terminal width", () => {
    const longRows: PickerRow[] = [
      { kind: "model", choice: { ...rows.find((row) => row.kind === "model")!.choice, model: "model-".repeat(30) } },
      { kind: "settings", label: "settings ".repeat(30) },
    ];
    for (const width of [1, 8, 19, 30, 80]) {
      const rendered = renderModelPicker({ rows: longRows, selected: 0 }, { ...options, width, price: () => "price ".repeat(20) });
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("the picker end to end", () => {
  async function* keys(sequence: ReturnType<typeof press>[]) {
    for (const key of sequence) yield key;
  }
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("moves and chooses, repainting as it goes", async () => {
    const frames: string[] = [];
    const chosen = await runModelPicker(keys([press("down"), press("return")]), (frame) => frames.push(frame), { ...options, rows });
    const expected = rows[initialSelection(rows, current) + 1];
    expect(chosen).toMatchObject({ kind: "model", choice: (expected as { choice: unknown }).choice });
    expect(frames).toHaveLength(2);
  });

  it("chooses nothing when dismissed", async () => {
    expect(await runModelPicker(keys([press("escape")]), () => {}, { ...options, rows })).toBeUndefined();
  });

  it("chooses nothing when the key stream ends, rather than switching on a closed stdin", async () => {
    expect(await runModelPicker(keys([press("down")]), () => {}, { ...options, rows })).toBeUndefined();
  });
});
