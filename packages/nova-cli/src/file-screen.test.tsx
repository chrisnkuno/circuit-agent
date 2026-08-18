/** @jsxImportSource @termuijs/jsx */
import { render } from "@termuijs/testing";
import { describe, expect, it } from "vitest";
import { FileScreen, type FileReader, type FileScreenChoice } from "./file-screen";

/**
 * The file screen, actually drawn and actually typed into.
 *
 * `file-browser.test.ts` proves what every key does; this proves the keys reach it, the rows reach
 * a terminal, and a selected file's contents actually arrive via the async reader.
 */

const PATHS = ["README.md", "src/index.ts", "src/deep/util.ts", "package.json"];

const reader: FileReader = async (path) => {
  if (path === "README.md") return { content: "# hello\nworld", totalLines: 2, truncated: false };
  if (path === "src/index.ts") return { content: "export {}", totalLines: 1, truncated: false };
  throw new Error(`unexpected read: ${path}`);
};

function open(options: { columns?: number; rows?: number; readFile?: FileReader } = {}) {
  let picked: FileScreenChoice | undefined;
  let exited = false;
  const view = render(
    <FileScreen
      columns={options.columns ?? 90}
      rows={options.rows ?? 20}
      paths={PATHS}
      readFile={options.readFile ?? reader}
      onExit={(value) => { exited = true; picked = value; }}
    />,
    { width: options.columns ?? 90, height: options.rows ?? 20 },
  );
  return {
    view,
    frame: () => String(view.lastFrame()),
    get exited() { return exited; },
    get picked() { return picked?.path; },
    get intent() { return picked?.intent; },
  };
}

describe("the file screen", () => {
  it("shows the top of the project tree", () => {
    const screen = open();
    const frame = screen.frame();
    expect(frame).toContain("src/");
    expect(frame).toContain("package.json");
    screen.view.unmount();
  });

  it("expands a folder on the right arrow, revealing its children", () => {
    const screen = open();
    expect(screen.frame()).not.toContain("index.ts");
    screen.view.pressKey("right");
    expect(screen.frame()).toContain("index.ts");
    screen.view.unmount();
  });

  it("fetches and shows a file's contents once it is selected", async () => {
    const screen = open();
    screen.view.pressKey("right"); // expand src/
    screen.view.pressKey("down"); // onto src/ children... first is deep/
    screen.view.pressKey("down"); // onto index.ts
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.frame()).toContain("export {}");
    screen.view.unmount();
  });

  it("picks a file on Enter and reports its path", () => {
    const screen = open();
    // README.md sorts after package.json among the top-level files; land on it by moving up once
    // from the top (wraps to the end of the list).
    screen.view.pressKey("up");
    screen.view.pressKey("return");
    expect(screen.exited).toBe(true);
    expect(screen.picked).toBe("README.md");
    screen.view.unmount();
  });

  it("toggles a folder open on Enter instead of picking it", () => {
    const screen = open();
    expect(screen.frame()).not.toContain("index.ts");
    screen.view.pressKey("return"); // src/ is the first row
    expect(screen.frame()).toContain("index.ts");
    expect(screen.exited).toBe(false);
    screen.view.unmount();
  });

  it("leaves without picking on q, and onExit gets no path", () => {
    const screen = open();
    screen.view.pressKey("q");
    expect(screen.exited).toBe(true);
    expect(screen.picked).toBeUndefined();
    screen.view.unmount();
  });

  it("filters as you type, and typing does not trigger navigation", () => {
    const screen = open();
    screen.view.pressKey("/");
    for (const character of "util") screen.view.pressKey(character);
    const frame = screen.frame();
    expect(frame).toContain("search: util");
    expect(frame).toContain("util.ts");
    expect(screen.exited).toBe(false);
    screen.view.unmount();
  });

  it("teaches its own keys", () => {
    const screen = open();
    expect(screen.frame()).toContain("q leave");
    screen.view.unmount();
  });
});
