/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";

afterEach(cleanup);

describe("the live changes panel", () => {
  it("shows the engine's current diff summary and opens the real patch", () => {
    const review = vi.fn();
    render(<ChangesPanel diffStat=" src/app.ts | 4 ++++" paths={["src/app.ts"]} busy={false} onReview={review} onFiles={() => undefined} />);
    expect(screen.getByText(/src\/app\.ts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review diff" }));
    expect(review).toHaveBeenCalledOnce();
  });

  it("says it is watching while work is in progress", () => {
    render(<ChangesPanel paths={[]} busy onReview={() => undefined} onFiles={() => undefined} />);
    expect(screen.getByText(/Watching the working tree/)).toBeTruthy();
  });
});
