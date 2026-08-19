import { describe, expect, it } from "vitest";
import { BrailleCanvas, dotRowFor, seriesBounds } from "./canvas";
import { ASCII_GLYPHS } from "./glyphs";

const lit = (rows: readonly string[]) => rows.join("").split("").filter((cell) => cell !== "⠀" && cell !== " ").length;

describe("braille canvas", () => {
  it("addresses eight dots per cell, and one per cell without braille", () => {
    const braille = new BrailleCanvas({ columns: 10, rows: 4 });
    expect([braille.width, braille.height]).toEqual([20, 16]);

    const ascii = new BrailleCanvas({ columns: 10, rows: 4, glyphs: ASCII_GLYPHS });
    expect([ascii.width, ascii.height]).toEqual([10, 4]);
  });

  it("renders a fixed block: every row exactly as wide as it was asked to be", () => {
    const canvas = new BrailleCanvas({ columns: 12, rows: 3 });
    canvas.set(5, 5);
    const rendered = canvas.render();
    expect(rendered).toHaveLength(3);
    expect(rendered.every((row) => [...row].length === 12)).toBe(true);
  });

  it("packs several dots into one cell rather than overwriting", () => {
    const canvas = new BrailleCanvas({ columns: 1, rows: 1 });
    canvas.set(0, 0);
    const one = canvas.render()[0];
    canvas.set(1, 3);
    const two = canvas.render()[0];

    expect(one).not.toBe("⠀");
    expect(two).not.toBe(one);
    // Both dots are still lit: the second set added a bit, it did not replace the cell.
    expect(two.codePointAt(0)! & one.codePointAt(0)!).toBe(one.codePointAt(0));
  });

  it("drops points outside the surface instead of clamping them onto its edge", () => {
    const canvas = new BrailleCanvas({ columns: 4, rows: 2 });
    canvas.set(-1, 0);
    canvas.set(0, -1);
    canvas.set(canvas.width, 0);
    canvas.set(0, canvas.height);
    canvas.set(Number.NaN, 0);
    expect(lit(canvas.render())).toBe(0);
  });

  it("draws a connected line: no column between the ends is left empty", () => {
    const canvas = new BrailleCanvas({ columns: 20, rows: 4 });
    canvas.line(0, 0, canvas.width - 1, canvas.height - 1);
    const rows = canvas.render();
    const columnsWithInk = new Set<number>();
    for (const row of rows) [...row].forEach((cell, column) => { if (cell !== "⠀") columnsWithInk.add(column); });
    expect(columnsWithInk.size).toBe(20);
  });

  it("clips a wild line rather than looping on it", () => {
    const canvas = new BrailleCanvas({ columns: 4, rows: 2 });
    canvas.line(-1_000, -1_000, 1_000, 1_000);
    expect(canvas.render()).toHaveLength(2);
  });
});

describe("scaling helpers", () => {
  it("puts the high value at the top row and the low value at the bottom", () => {
    expect(dotRowFor(10, 0, 10, 8)).toBe(0);
    expect(dotRowFor(0, 0, 10, 8)).toBe(7);
    expect(dotRowFor(5, 0, 10, 9)).toBe(4);
  });

  it("gives a flat series a nominal span so it plots through the middle rather than dividing by zero", () => {
    expect(seriesBounds([3, 3, 3])).toEqual({ low: 3, high: 3, span: 1 });
    expect(Number.isFinite(dotRowFor(3, 3, 1, 8))).toBe(true);
  });

  it("ignores values that are not numbers, and reports nothing for an empty series", () => {
    expect(seriesBounds([1, Number.NaN, 5, Number.POSITIVE_INFINITY])).toEqual({ low: 1, high: 5, span: 4 });
    expect(seriesBounds([])).toEqual({ low: 0, high: 0, span: 1 });
  });
});
