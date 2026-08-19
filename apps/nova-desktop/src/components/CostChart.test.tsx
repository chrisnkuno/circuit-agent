/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CostChart } from "./CostChart";
import type { TurnCostPoint } from "../lib/cost-chart";

afterEach(cleanup);

const turn = (turnNumber: number, micros?: number): TurnCostPoint => ({
  turnNumber,
  ...(micros === undefined ? {} : { cost: { micros, currency: "RWF" }, display: `RWF ${micros / 1000}` }),
  inputTokens: 1200,
  outputTokens: 300,
  toolCalls: 2,
  iterations: 3,
  elapsedMs: 5000,
});

describe("the cost charts", () => {
  it("draws one mark per turn", () => {
    const { container } = render(<CostChart turns={[turn(1, 1000), turn(2, 3000), turn(3, 2000)]} />);
    expect(container.querySelectorAll(".chart-bar")).toHaveLength(3);
  });

  it("keeps cost and cumulative spend on separate plots", () => {
    // Never one chart with two vertical scales: the two measures have different units, and their
    // crossings on a shared axis would look meaningful when they are an artefact of the scaling.
    const { container } = render(<CostChart turns={[turn(1, 1000), turn(2, 3000)]} />);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("names the dearest turn in words, not only by drawing it taller", () => {
    render(<CostChart turns={[turn(1, 1000), turn(2, 9000)]} />);
    expect(screen.getByText(/Dearest turn 2/)).toBeTruthy();
  });

  it("gives every bar a hover label naming its turn and cost", () => {
    const { container } = render(<CostChart turns={[turn(1, 1500)]} />);
    expect(container.querySelector(".chart-bar title")?.textContent).toBe("Turn 1 · RWF 1.5");
  });

  it("says a turn's price is unknown rather than drawing it as free", () => {
    const { container } = render(<CostChart turns={[turn(1)]} />);
    expect(container.querySelector(".chart-bar title")?.textContent).toContain("cost unknown");
    expect(screen.getByText(/No turn here has a known price/)).toBeTruthy();
  });

  it("describes itself for a reader who cannot see it", () => {
    const { container } = render(<CostChart turns={[turn(1, 1000), turn(2, 4000)]} />);
    const label = container.querySelector("svg")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("2 turns");
    expect(label).toContain("turn 2");
  });

  it("draws nothing at all before the first turn finishes", () => {
    const { container } = render(<CostChart turns={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("survives a single turn without dividing by zero", () => {
    const { container } = render(<CostChart turns={[turn(1, 1000)]} />);
    const points = container.querySelector(".chart-line")?.getAttribute("points") ?? "";
    expect(points).not.toContain("NaN");
  });

  it("survives a session where nothing has a price", () => {
    const { container } = render(<CostChart turns={[turn(1), turn(2)]} />);
    expect(container.querySelector(".chart-line")?.getAttribute("points")).not.toContain("NaN");
  });
});
