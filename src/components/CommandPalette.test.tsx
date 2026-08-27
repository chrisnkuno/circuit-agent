/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette, type DesktopCommand } from "./CommandPalette";

afterEach(cleanup);

const commands = (): DesktopCommand[] => [
  { id: "diff", label: "Review changes", description: "Open the current unified diff", shortcut: "Ctrl D", run: vi.fn() },
  { id: "memory", label: "Manage memory", description: "Project and personal facts", run: vi.fn() },
  { id: "undo", label: "Undo last turn", description: "Restore files and conversation", disabled: true, run: vi.fn() },
];

describe("the desktop command palette", () => {
  it("finds commands by intent, not only by their label", () => {
    render(<CommandPalette open onClose={() => {}} commands={commands()} />);
    fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "unified" } });
    expect(screen.getByText("Review changes")).toBeTruthy();
    expect(screen.queryByText("Manage memory")).toBeNull();
  });

  it("runs the chosen command and closes", () => {
    const list = commands();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={list} />);
    fireEvent.click(screen.getByRole("option", { name: /Manage memory/ }));
    expect(list[1].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not offer an unavailable action as executable", () => {
    render(<CommandPalette open onClose={() => {}} commands={commands()} />);
    expect((screen.getByRole("option", { name: /Undo last turn/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
