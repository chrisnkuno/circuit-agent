import { describe, expect, it } from "vitest";
import { computeLayout, GOLDEN_RATIO } from "./layout";

describe("a normal terminal", () => {
  it("reserves the input bar's three rows below the transcript", () => {
    const layout = computeLayout(40, 100);
    expect(layout.footerRows).toBe(3);
    expect(layout.scrollBottom).toBe(37);
    expect(layout.statusRow).toBe(38); // the bar's top border, which carries the status text
    expect(layout.inputRow).toBe(39);
    expect(layout.promptBottomRow).toBe(40); // the closing border, on the terminal's last row
    expect(layout.scrollTop).toBe(1);
  });

  it("scales with the terminal, not a fixed row count", () => {
    expect(computeLayout(24, 80).promptBottomRow).toBe(24);
    expect(computeLayout(120, 80).promptBottomRow).toBe(120);
  });

  it("keeps the footer's rows contiguous and in order, at every size that has one", () => {
    // The three rows are drawn independently, by three different calls, onto absolute row numbers.
    // Nothing downstream re-checks that they are adjacent — a gap or an inversion here would draw
    // a box with transcript running through the middle of it.
    for (let rows = 1; rows <= 200; rows += 1) {
      const layout = computeLayout(rows, 80);
      const footer = [layout.statusRow, layout.inputRow, layout.promptBottomRow].filter((row) => row !== undefined);
      expect(footer.length, `rows ${rows}`).toBe(layout.footerRows);
      footer.forEach((row, index) => {
        expect(row, `rows ${rows}`).toBe(layout.scrollBottom + index + 1);
      });
      expect(layout.scrollBottom + layout.footerRows, `rows ${rows}`).toBe(Math.max(1, rows));
    }
  });
});

describe("narrowing under real constraints", () => {
  it("gives up the closing border first, keeping the status and the input line", () => {
    // MIN_TRANSCRIPT_ROWS=3, so a 5-row terminal can spare exactly two footer rows.
    const layout = computeLayout(5, 80);
    expect(layout.footerRows).toBe(2);
    expect(layout.statusRow).toBe(4);
    expect(layout.inputRow).toBe(5);
    expect(layout.promptBottomRow).toBeUndefined();
  });

  it("gives up the status row before the input row, on a short terminal", () => {
    const layout = computeLayout(4, 80);
    expect(layout.footerRows).toBe(1);
    expect(layout.statusRow).toBeUndefined();
    expect(layout.inputRow).toBe(4);
    expect(layout.promptBottomRow).toBeUndefined();
  });

  it("falls back to plain scrolling — no pinned row at all — below that", () => {
    const layout = computeLayout(3, 80);
    expect(layout.footerRows).toBe(0);
    expect(layout.statusRow).toBeUndefined();
    expect(layout.inputRow).toBeUndefined();
    expect(layout.promptBottomRow).toBeUndefined();
    expect(layout.scrollBottom).toBe(3);
  });

  it("never produces a negative or zero scroll region, even on a one-row terminal", () => {
    const layout = computeLayout(1, 80);
    expect(layout.footerRows).toBe(0);
    expect(layout.scrollTop).toBeLessThanOrEqual(layout.scrollBottom);
    expect(layout.scrollBottom).toBeGreaterThan(0);
  });
});

describe("content width", () => {
  const CAP = Math.round(80 * GOLDEN_RATIO);

  it("uses the full width up to the cap", () => {
    expect(computeLayout(40, 60).contentWidth).toBe(60);
    expect(computeLayout(40, CAP).contentWidth).toBe(CAP);
  });

  it("stops growing past the cap, rather than stretching prose edge to edge forever", () => {
    // The failure mode a naive "divide the current width by phi" formula has: text keeps getting
    // wider on an ever-wider terminal, which defeats the entire point of a bounded reading measure.
    // A real cap is a max-width, constant once past it — a 300-column terminal and a 500-column one
    // must wrap prose identically.
    expect(computeLayout(40, 300).contentWidth).toBe(CAP);
    expect(computeLayout(40, 500).contentWidth).toBe(CAP);
  });

  it("is exactly continuous at the cap — min() of two continuous functions has no seam", () => {
    expect(computeLayout(40, CAP - 1).contentWidth).toBe(CAP - 1);
    expect(computeLayout(40, CAP).contentWidth).toBe(CAP);
    expect(computeLayout(40, CAP + 1).contentWidth).toBe(CAP);
  });
});

describe("defensive inputs", () => {
  it("floors fractional terminal sizes rather than producing fractional rows", () => {
    const layout = computeLayout(40.7, 100.9);
    expect(Number.isInteger(layout.rows)).toBe(true);
    expect(Number.isInteger(layout.columns)).toBe(true);
  });

  it("treats zero or negative sizes as the smallest real terminal, not a crash", () => {
    expect(() => computeLayout(0, 0)).not.toThrow();
    expect(() => computeLayout(-5, -5)).not.toThrow();
    const layout = computeLayout(0, 0);
    expect(layout.rows).toBeGreaterThan(0);
    expect(layout.columns).toBeGreaterThan(0);
  });
});
