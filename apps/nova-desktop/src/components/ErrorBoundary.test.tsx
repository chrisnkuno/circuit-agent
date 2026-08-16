import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * The boundary, actually made to catch something.
 *
 * `crash.ts` proves the report is well-formed whatever gets thrown. This proves the boundary is
 * wired to it: that a throwing child produces the recovery screen rather than an empty window, and
 * that "Try again" genuinely re-renders instead of leaving the crash on screen forever. Neither is
 * reachable without rendering a component that throws.
 */

afterEach(cleanup);

/** React logs caught errors to console.error; silenced so a passing run is not full of stack traces. */
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => { consoleError = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => consoleError.mockRestore());

function Boom({ throws }: { throws: boolean }) {
  if (throws) throw new Error("the sidecar went away");
  return <p>working again</p>;
}

/**
 * Throws while the flag is set, so a test can clear the cause and then press Try again.
 *
 * Deliberately not "throws on first render only": React re-renders a failed subtree to collect its
 * component stack, so a once-only throw succeeds on that retry and the boundary never trips.
 */
let shouldThrow = true;
function ConditionalBoom() {
  if (shouldThrow) throw new Error("a transient failure");
  return <p>working again</p>;
}

describe("the error boundary", () => {
  it("renders its children when nothing is wrong", () => {
    render(<ErrorBoundary><p>all fine</p></ErrorBoundary>);
    expect(screen.getByText("all fine")).toBeTruthy();
  });

  it("catches a render error and shows the message instead of a blank window", () => {
    render(<ErrorBoundary><Boom throws /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();
    // Named in the heading *and* in the stack below it, so there are legitimately two matches.
    expect(screen.getAllByText(/the sidecar went away/).length).toBeGreaterThan(0);
  });

  it("offers a way out that does not involve killing the process", () => {
    render(<ErrorBoundary><Boom throws /></ErrorBoundary>);
    expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy details/i })).toBeTruthy();
  });

  it("recovers when Try again is pressed and the cause has gone", () => {
    // The whole point of the button: a transient failure should not cost the window.
    shouldThrow = true;
    render(<ErrorBoundary><ConditionalBoom /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();

    shouldThrow = false; // the cause has gone
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    expect(screen.getByText("working again")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts a report on the clipboard, led by the version it came from", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Defined rather than assigned: navigator.clipboard is a read-only accessor in a real DOM.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ErrorBoundary version="9.9.9"><Boom throws /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: /Copy details/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const [text] = writeText.mock.calls[0] as [string];
    expect(text.split("\n")[0]).toContain("Nova 9.9.9");
    expect(text).toContain("the sidecar went away");
  });

  it("still says something useful when a non-Error is thrown", () => {
    function ThrowString(): never { throw "just a string"; }
    render(<ErrorBoundary><ThrowString /></ErrorBoundary>);
    expect(screen.getAllByText(/just a string/).length).toBeGreaterThan(0);
  });
});
