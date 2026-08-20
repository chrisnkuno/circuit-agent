/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModeBar } from "./ModeBar";

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof ModeBar>[0]> = {}) {
  const props = {
    mode: "build" as const,
    busy: false,
    onMode: vi.fn(),
    onUndo: vi.fn(),
    onCancel: vi.fn(),
    onShowDiff: vi.fn(),
    onScan: vi.fn(),
    onFiles: vi.fn(),
    ...overrides,
  };
  render(<ModeBar {...props} />);
  return props;
}

describe("the mode bar", () => {
  it("presents the modes as one control with one value", () => {
    renderBar({ mode: "auto" });
    // A single-value toggle group is a radio group to assistive technology, which is the whole
    // reason it is one control rather than four buttons: "Auto, 3 of 4", not four unrelated names.
    expect(screen.getByRole("radiogroup", { name: "Permission mode" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports the mode that was chosen", () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole("radio", { name: "Defender" }));
    expect(props.onMode).toHaveBeenCalledWith("defender");
  });

  it("never reports an empty mode", () => {
    // Radix reports "" when the pressed item is toggled off. A permission mode has no "off", and
    // pushing "" into state would leave the session in a mode that does not exist.
    const props = renderBar({ mode: "build" });
    fireEvent.click(screen.getByRole("radio", { name: "Build" }));
    for (const call of (props.onMode as ReturnType<typeof vi.fn>).mock.calls) expect(call[0]).not.toBe("");
  });

  it("says in words what the current mode allows", () => {
    // The most consequential state in the window must not have its meaning live only in a tooltip.
    renderBar({ mode: "plan" });
    expect(screen.getByText(/writes nothing/i)).toBeTruthy();
  });

  it("offers Stop only while there is something to stop", () => {
    renderBar({ busy: false });
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderBar({ busy: true });
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("locks the mode while a turn is running", () => {
    renderBar({ busy: true });
    expect((screen.getByRole("radio", { name: "Plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves 'where the work runs' to the inspector", () => {
    // It is a property of the session, not an action on a turn, and it cost this row the width the
    // mode's own sentence needed. See the note at the top of ModeBar.tsx.
    renderBar();
    expect(screen.queryByRole("button", { name: /Sandbox/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pull files/ })).toBeNull();
  });
});
