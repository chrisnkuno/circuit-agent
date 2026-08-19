/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GuidePanel } from "./GuidePanel";
import { GUIDE } from "../lib/guide";

afterEach(cleanup);

describe("the guide panel", () => {
  it("opens on a topic rather than on an empty pane", () => {
    render(<GuidePanel open onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(GUIDE[0].title);
  });

  it("shows the topic you pick", () => {
    render(<GuidePanel open onClose={() => {}} />);
    const modes = GUIDE.find((topic) => topic.id === "modes")!;
    fireEvent.click(screen.getByText(modes.title));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(modes.title);
    expect(screen.getByText(modes.body[0])).toBeTruthy();
  });

  it("narrows the index without throwing away what you are reading", () => {
    // The index is a dozen rows: filtering it should not also blank the pane, or a search that
    // matches nothing leaves you with no guide at all.
    render(<GuidePanel open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Search the guide"), { target: { value: "sandbox" } });
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
    expect(screen.queryByText(GUIDE.find((t) => t.id === "scan")!.summary)).toBeNull();
  });

  it("says so when a search matches nothing", () => {
    render(<GuidePanel open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Search the guide"), { target: { value: "zzzz" } });
    expect(screen.getByText(/Nothing in the guide mentions/)).toBeTruthy();
  });

  it("prints the keys for a topic that has them", () => {
    render(<GuidePanel open onClose={() => {}} />);
    fireEvent.click(screen.getByText(GUIDE.find((topic) => topic.id === "tabs")!.title));
    expect(screen.getByText("Ctrl T")).toBeTruthy();
  });

  it("closes on Escape, like every other panel in the window", () => {
    const onClose = vi.fn();
    render(<GuidePanel open onClose={onClose} />);
    // Fired at the dialog, which is where a real Escape starts: focus is trapped inside the panel
    // while it is open, and the event bubbles from there to the document listener that closes it.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing at all when closed", () => {
    const { container } = render(<GuidePanel open={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
