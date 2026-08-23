import { describe, expect, it } from "vitest";
import { renderReliabilityStatus } from "./reliability-status";

const snapshot = {
  score: 97.6,
  grade: "excellent",
  generatedAt: "2026-08-23T02:00:00.000Z",
};

describe("the startup reliability signal", () => {
  it("names the measured score, evidence date, and direction", () => {
    expect(renderReliabilityStatus(100, "·", snapshot)).toBe(
      "reliability 98/100 · excellent · measured 2026-08-23 · improving toward best-in-class",
    );
  });

  it("keeps the useful signal in a narrow terminal", () => {
    const rendered = renderReliabilityStatus(40, ".", snapshot);
    expect(rendered).toBe("reliability 98/100 . improving daily");
    expect(rendered.length).toBeLessThanOrEqual(40);
  });

  it("bounds corrupt scores instead of printing nonsense", () => {
    expect(
      renderReliabilityStatus(40, "·", { ...snapshot, score: 900 }),
    ).toContain("100/100");
    expect(
      renderReliabilityStatus(40, "·", { ...snapshot, score: -2 }),
    ).toContain("0/100");
  });
});
