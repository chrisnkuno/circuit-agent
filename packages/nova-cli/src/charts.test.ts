import { describe, expect, it } from "vitest";
import { barChart, heatStrip, lineChart, plotSeries, scatterChart, StreamSeries, waveLine } from "./charts";
import { ASCII_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const SPEND = [
  { label: "turn 1", value: 1_200 },
  { label: "turn 2", value: 340 },
  { label: "turn 3", value: 5_600 },
];

describe("barChart", () => {
  it("draws one row per datum, every row exactly the requested width", () => {
    const rows = barChart(SPEND, { width: 60, depth: "none" });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(visibleWidth(plain(row))).toBe(60);
  });

  it("scales bars against the largest value, so the biggest fills and the rest are read against it", () => {
    const rows = barChart(SPEND, { width: 60, depth: "none" }).map(plain);
    const filled = (row: string) => [...row].filter((character) => character === "█").length;
    // turn 3 is the ceiling, turn 2 the smallest.
    expect(filled(rows[2])).toBeGreaterThan(filled(rows[0]));
    expect(filled(rows[0])).toBeGreaterThan(filled(rows[1]));
  });

  it("honours an explicit ceiling, so several charts can share one scale", () => {
    const own = plain(barChart([{ label: "a", value: 5 }], { width: 40, depth: "none" })[0]);
    const shared = plain(barChart([{ label: "a", value: 5 }], { width: 40, depth: "none", max: 100 })[0]);
    const filled = (row: string) => [...row].filter((character) => character === "█").length;
    expect(filled(own)).toBeGreaterThan(filled(shared));
  });

  it("does not divide by zero when every value is zero", () => {
    const rows = barChart([{ label: "a", value: 0 }, { label: "b", value: 0 }], { width: 40, depth: "none" });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(visibleWidth(plain(row))).toBe(40);
  });

  it("formats values with the caller's own formatter", () => {
    const rows = barChart([{ label: "spend", value: 12_000 }], { width: 50, depth: "none", format: (v) => `$${(v / 10_000).toFixed(2)}` });
    expect(plain(rows[0])).toContain("$1.20");
  });

  it("clips a long label rather than pushing the row past its width", () => {
    const rows = barChart([{ label: "an extremely long label that would not fit", value: 1 }], { width: 40, depth: "none" });
    expect(visibleWidth(plain(rows[0]))).toBe(40);
  });

  it("returns nothing for no data, rather than a chart of nothing", () => {
    expect(barChart([], { width: 40, depth: "none" })).toEqual([]);
  });

  it("paints only when colour is wanted", () => {
    expect(barChart(SPEND, { width: 40, depth: "none" }).join("")).not.toMatch(/\x1b\[/);
    expect(barChart(SPEND, { width: 40, depth: "truecolor" }).join("")).toMatch(/\x1b\[/);
  });

  it("stays inside ASCII on an ASCII terminal", () => {
    for (const row of barChart(SPEND, { width: 40, depth: "none", glyphs: ASCII_GLYPHS })) {
      for (const character of plain(row)) expect(character.codePointAt(0)).toBeLessThan(128);
    }
  });
});

describe("lineChart", () => {
  const rising = Array.from({ length: 30 }, (_unused, index) => index);

  it("is exactly as tall as asked, and no row exceeds the width", () => {
    for (const height of [1, 4, 8]) {
      const rows = lineChart(rising, { width: 50, height, depth: "none" });
      expect(rows, `height ${height}`).toHaveLength(height);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
    }
  });

  it("puts a rising series at the bottom-left and top-right, not the other way up", () => {
    // Row 0 is the top of the chart, so the *last* column is the one that should be drawn there.
    const rows = lineChart(rising, { width: 40, height: 4, depth: "none", bare: true });
    const inked = (row: string) => [...row].map((character, index) => (character === "⠀" ? -1 : index)).filter((index) => index >= 0);
    expect(Math.max(...inked(rows[0]))).toBeGreaterThan(Math.max(...inked(rows[rows.length - 1])));
  });

  it("labels the top and bottom of the y axis with the series' own bounds", () => {
    const rows = lineChart([10, 90], { width: 40, height: 4, depth: "none" });
    expect(rows[0]).toContain("90");
    expect(rows[rows.length - 1]).toContain("10");
  });

  it("drops the gutter entirely when asked to draw bare", () => {
    const bare = lineChart([10, 90], { width: 40, height: 3, depth: "none", bare: true });
    expect(bare[0]).not.toContain("90");
  });

  it("draws a flat series without dividing by a zero range", () => {
    const rows = lineChart([7, 7, 7, 7], { width: 30, height: 3, depth: "none", bare: true });
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => [...row].some((character) => character !== "⠀"))).toBe(true);
  });

  it("survives an empty series and one that is entirely non-finite", () => {
    expect(lineChart([], { width: 30, height: 3, depth: "none" })).toHaveLength(3);
    expect(lineChart([Number.NaN, Number.POSITIVE_INFINITY], { width: 30, height: 3, depth: "none" })).toHaveLength(3);
  });

  it("spans the full width whether the series is longer or shorter than the chart", () => {
    for (const length of [2, 5, 500]) {
      const series = Array.from({ length }, (_unused, index) => index);
      const rows = lineChart(series, { width: 30, height: 3, depth: "none", bare: true });
      const anyInk = rows.some((row) => [...row].some((character) => character !== "⠀"));
      expect(anyInk, `length ${length}`).toBe(true);
      // Something must be drawn in the final column, or the plot stopped short of its own edge.
      expect(rows.some((row) => row[row.length - 1] !== "⠀"), `length ${length} right edge`).toBe(true);
    }
  });

  it("falls back to a coarse plot, still inside ASCII, on an ASCII terminal", () => {
    const rows = lineChart(rising, { width: 40, height: 4, depth: "none", glyphs: ASCII_GLYPHS });
    for (const row of rows) for (const character of row) expect(character.codePointAt(0)).toBeLessThan(128);
    expect(rows.join("")).toContain("*");
  });
});

describe("heatStrip", () => {
  const findings = [
    { label: "critical", value: 2 },
    { label: "high", value: 8 },
    { label: "medium", value: 4 },
  ];

  it("draws one full-width row per bucket, shaded by magnitude", () => {
    const rows = heatStrip(findings, { width: 40, depth: "none" });
    expect(rows).toHaveLength(3);
    const widths = new Set(rows.map((row) => visibleWidth(row)));
    expect(widths.size).toBe(1);
  });

  it("shades the largest bucket more heavily than the smallest", () => {
    const levels = "▁▂▃▄▅▆▇█";
    const rows = heatStrip(findings, { width: 40, depth: "none" });
    const shadeOf = (row: string) => levels.indexOf(row.trim().split(" ").pop()![0]);
    expect(shadeOf(rows[1])).toBeGreaterThan(shadeOf(rows[0]));
  });

  it("does not divide by zero when every bucket is empty", () => {
    expect(heatStrip([{ label: "none", value: 0 }], { width: 30, depth: "none" })).toHaveLength(1);
  });

  it("returns nothing for no data", () => {
    expect(heatStrip([], { width: 30, depth: "none" })).toEqual([]);
  });

  it("stays inside ASCII on an ASCII terminal", () => {
    for (const row of heatStrip(findings, { width: 30, depth: "none", glyphs: ASCII_GLYPHS })) {
      for (const character of row) expect(character.codePointAt(0)).toBeLessThan(128);
    }
  });
});

describe("scatter plots", () => {
  const options = { width: 24, height: 4, depth: "none" as const };

  it("returns exactly the block it was asked for, whatever the data", () => {
    for (const points of [[], [{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 10, y: 10 }], [{ x: 3, y: 7 }, { x: 3, y: 7 }]]) {
      const rendered = scatterChart(points, options);
      expect(rendered).toHaveLength(4);
    }
  });

  it("places the extremes in opposite corners", () => {
    const rendered = scatterChart([{ x: 0, y: 0 }, { x: 100, y: 100 }], { ...options, bare: true });
    expect(rendered[0].trimEnd().length).toBe(rendered[0].length); // the top row ends with ink
    expect(rendered.at(-1)!.startsWith("⠀")).toBe(false);
  });

  it("does not connect its points — that is what a line chart is for", () => {
    const scattered = scatterChart([{ x: 0, y: 0 }, { x: 10, y: 10 }], { ...options, bare: true });
    const lined = lineChart([0, 10], { ...options, bare: true });
    const ink = (rows: readonly string[]) => rows.join("").split("").filter((cell) => cell !== "⠀").length;
    expect(ink(scattered)).toBeLessThan(ink(lined));
  });

  it("ignores points that are not numbers", () => {
    expect(scatterChart([{ x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }], options).join("").trim()).toBe("");
  });
});

describe("wave lines", () => {
  it("is exactly one row, exactly the requested width", () => {
    for (const width of [1, 8, 40]) {
      const wave = waveLine([1, 5, 2, 8, 3], { width });
      expect(wave.includes("\n")).toBe(false);
      expect([...wave]).toHaveLength(width);
    }
  });

  it("shows direction: a rising series slopes up and a falling one slopes down", () => {
    const rising = waveLine([0, 1, 2, 3, 4, 5, 6, 7], { width: 8 });
    const falling = waveLine([7, 6, 5, 4, 3, 2, 1, 0], { width: 8 });
    expect(rising).toContain("╱");
    expect(falling).toContain("╲");
  });

  it("stays level for a steady series rather than shimmering between runes", () => {
    const flat = waveLine([5, 5, 5, 5, 5, 5], { width: 6 });
    expect(new Set([...flat]).size).toBe(1);
  });

  it("has an ASCII form for terminals that cannot draw the runes", () => {
    const wave = waveLine([0, 5, 1, 6], { width: 12, glyphs: ASCII_GLYPHS });
    expect(/^[-_^/\\]+$/.test(wave)).toBe(true);
  });

  it("renders nothing for a series with nothing in it", () => {
    expect(waveLine([], { width: 10 })).toBe("");
    expect(waveLine([Number.NaN], { width: 10 })).toBe("");
  });
});

describe("streaming series", () => {
  it("keeps the most recent samples, oldest first, and never grows past its capacity", () => {
    const stream = new StreamSeries(4);
    for (const value of [1, 2, 3, 4, 5, 6]) stream.push(value);
    expect(stream.values()).toEqual([3, 4, 5, 6]);
    expect(stream.length).toBe(4);
  });

  it("holds an unfilled window without padding it", () => {
    const stream = new StreamSeries(5);
    stream.push(1);
    stream.push(2);
    expect(stream.values()).toEqual([1, 2]);
  });

  it("refuses samples that are not numbers, and a capacity that is not a size", () => {
    const stream = new StreamSeries(3);
    stream.push(Number.NaN);
    stream.push(Number.POSITIVE_INFINITY);
    expect(stream.values()).toEqual([]);
    expect(() => new StreamSeries(0)).toThrow();
    expect(() => new StreamSeries(1.5)).toThrow();
  });

  it("hands a snapshot to the caller, not its own buffer", () => {
    const stream = new StreamSeries(3);
    stream.push(1);
    const snapshot = stream.values();
    snapshot.push(99);
    expect(stream.values()).toEqual([1]);
  });
});

describe("several series at once", () => {
  it("scales them together, so two series drawn side by side are comparable", () => {
    const together = plotSeries([{ values: [0, 1, 2] }, { values: [0, 50, 100] }], { width: 20, height: 4, depth: "none", bare: true });
    const alone = plotSeries([{ values: [0, 1, 2] }], { width: 20, height: 4, depth: "none", bare: true });
    // Against a neighbour reaching 100, the small series is a flat line near the bottom; alone it
    // spans the whole height. Same data, different meaning — which is the point of a shared scale.
    const rowsWithInk = (rows: readonly string[]) => rows.filter((row) => [...row].some((cell) => cell !== "⠀")).length;
    expect(rowsWithInk(alone)).toBeGreaterThan(1);
    expect(rowsWithInk(together)).toBeGreaterThanOrEqual(rowsWithInk(alone));
  });
});
