/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

const listFiles = vi.fn();
const readFile = vi.fn();
vi.mock("../lib/ipc", () => ({ listFiles: (...args: unknown[]) => listFiles(...args), readFile: (...args: unknown[]) => readFile(...args) }));

const { FilePanel } = await import("./FilePanel");

/**
 * The explorer exists so that "what is in this file" can be answered without leaving the window.
 * Two behaviours carry that, and both are easy to get subtly wrong: reading has to go to the tab
 * that was asked about (a preview of the right name from the wrong project looks completely
 * normal), and looking at a file must not be the same act as mentioning it in the composer.
 */

afterEach(cleanup);

beforeEach(() => {
  listFiles.mockReset();
  readFile.mockReset();
  listFiles.mockResolvedValue({ files: ["src/app.ts", "README.md"] });
  readFile.mockResolvedValue({ file: { path: "README.md", content: "hello from the file", startLine: 1, totalLines: 1, truncated: false } });
});

function open(onPick = vi.fn(), tabId = "tab_7") {
  render(<FilePanel open onClose={() => {}} onPick={onPick} tabId={tabId} />);
  return onPick;
}

describe("the file explorer", () => {
  it("shows a file's contents in the window", async () => {
    open();
    fireEvent.click(await screen.findByTitle("Show README.md"));
    expect(await screen.findByText("hello from the file")).toBeTruthy();
  });

  it("re-reads an open file when the agent changes the workspace", async () => {
    readFile
      .mockResolvedValueOnce({ file: { path: "README.md", content: "before", startLine: 1, totalLines: 1, truncated: false } })
      .mockResolvedValueOnce({ file: { path: "README.md", content: "after", startLine: 1, totalLines: 1, truncated: false } });
    const view = render(<FilePanel open onClose={() => {}} onPick={() => {}} tabId="tab_7" refreshKey={0} />);
    fireEvent.click(await screen.findByTitle("Show README.md"));
    expect(await screen.findByText("before")).toBeTruthy();
    view.rerender(<FilePanel open onClose={() => {}} onPick={() => {}} tabId="tab_7" refreshKey={1} />);
    expect(await screen.findByText("after")).toBeTruthy();
  });

  it("asks the tab it belongs to for the file, not whichever session is in front", async () => {
    // A sandboxed tab's files do not exist on this machine, so an unaddressed read is not merely
    // untidy — it answers with a different file that happens to share a name.
    open(vi.fn(), "tab_42");
    fireEvent.click(await screen.findByTitle("Show README.md"));
    await waitFor(() => expect(readFile).toHaveBeenCalled());
    expect(readFile.mock.calls[0][1]).toBe("tab_42");
  });

  it("does not put a file in the composer just because it was read", async () => {
    const onPick = open();
    fireEvent.click(await screen.findByTitle("Show README.md"));
    await screen.findByText("hello from the file");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("mentions a file when that is what was asked for", async () => {
    const onPick = open();
    fireEvent.click((await screen.findAllByTitle("Mention README.md"))[0]);
    expect(onPick).toHaveBeenCalledWith("README.md");
  });

  it("says so when only part of a long file was read", async () => {
    // Silently showing the first slice of a file as though it were the whole thing is how someone
    // concludes a function is missing.
    readFile.mockResolvedValue({ file: { path: "big.log", content: "x", startLine: 1, totalLines: 90_000, truncated: true } });
    open();
    fireEvent.click(await screen.findByTitle("Show README.md"));
    expect(await screen.findByText(/of 90,000 lines/)).toBeTruthy();
  });

  it("reports a file it could not read instead of showing an empty pane", async () => {
    readFile.mockRejectedValue(new Error("outside the workspace"));
    open();
    fireEvent.click(await screen.findByTitle("Show README.md"));
    expect(await screen.findByText(/outside the workspace/)).toBeTruthy();
  });
});
