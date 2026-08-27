/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listMemories = vi.fn();
const addMemory = vi.fn();
const forgetMemory = vi.fn();
vi.mock("../lib/ipc", () => ({
  listMemories: (...args: unknown[]) => listMemories(...args),
  addMemory: (...args: unknown[]) => addMemory(...args),
  forgetMemory: (...args: unknown[]) => forgetMemory(...args),
}));
const { MemoryPanel } = await import("./MemoryPanel");

afterEach(cleanup);
beforeEach(() => {
  listMemories.mockReset();
  addMemory.mockReset();
  forgetMemory.mockReset();
  listMemories.mockResolvedValue({
    entries: [{ scope: "project", index: 1, text: "Use Bun", kind: "convention", pinned: false }],
    files: { project: "/repo/.nova/memory.md", user: "/user/.config/nova/memory.md" },
  });
  addMemory.mockResolvedValue({ changed: true, entries: [] });
  forgetMemory.mockResolvedValue({ changed: true, entries: [] });
});

describe("the shared memory panel", () => {
  it("shows existing CLI-compatible memory and its storage paths", async () => {
    render(<MemoryPanel open onClose={() => {}} tabId="tab_2" />);
    expect(await screen.findByText("Use Bun")).toBeTruthy();
    fireEvent.click(screen.getByText("Storage files"));
    expect(screen.getByText("/repo/.nova/memory.md")).toBeTruthy();
    expect(listMemories).toHaveBeenCalledWith("tab_2");
  });

  it("adds a scoped, typed memory and refreshes from the source of record", async () => {
    render(<MemoryPanel open onClose={() => {}} tabId="tab_2" />);
    await screen.findByText("Use Bun");
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "Prefer focused tests first" } });
    fireEvent.change(screen.getByLabelText("Memory kind"), { target: { value: "preference" } });
    fireEvent.change(screen.getByLabelText("Memory scope"), { target: { value: "user" } });
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(addMemory).toHaveBeenCalledWith("user", "Prefer focused tests first", "preference", "tab_2"));
    expect(listMemories).toHaveBeenCalledTimes(2);
  });

  it("forgets the exact scoped index rather than deleting by display order", async () => {
    render(<MemoryPanel open onClose={() => {}} tabId="tab_2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
    await waitFor(() => expect(forgetMemory).toHaveBeenCalledWith("project", 1, "tab_2"));
  });
});
