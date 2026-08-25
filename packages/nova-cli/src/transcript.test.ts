import { describe, expect, it } from "vitest";
import { describeToolCall, summarizeToolResult, truncateMiddle } from "./transcript";

describe("truncateMiddle", () => {
  it("leaves a short value untouched", () => {
    expect(truncateMiddle("npm test", 40)).toBe("npm test");
  });

  it("keeps both ends of a long value, which is where the meaning lives", () => {
    const result = truncateMiddle("src/components/deeply/nested/module.ts", 20);
    expect(result).toHaveLength(20);
    expect(result.startsWith("src/")).toBe(true);
    expect(result.endsWith(".ts")).toBe(true);
    expect(result).toContain("…");
  });

  it("collapses whitespace so a multi-line argument stays one line", () => {
    expect(truncateMiddle("npm run\n  build", 40)).toBe("npm run build");
  });

  it("does not overflow at absurdly small widths", () => {
    expect(truncateMiddle("abcdef", 1).length).toBeLessThanOrEqual(1);
    expect(truncateMiddle("abcdef", 0)).toBe("");
  });
});

describe("describeToolCall", () => {
  it("names the file a read is about", () => {
    expect(describeToolCall("read_file", { path: "src/app.ts" })).toBe("src/app.ts");
  });

  it("says which lines a ranged read asked for, since that is a different act", () => {
    expect(describeToolCall("read_file", { path: "a.ts", offset: 10, limit: 20 })).toBe("a.ts:10-29");
    expect(describeToolCall("read_file", { path: "a.ts", offset: 10 })).toBe("a.ts:10+");
  });

  it("shows the search and where it was scoped", () => {
    expect(describeToolCall("grep_files", { query: "TODO" })).toBe('"TODO"');
    expect(describeToolCall("grep_files", { query: "TODO", include: "**/*.ts" })).toBe('"TODO" in **/*.ts');
  });

  it("shows the scope a secret scan was limited to, or nothing for a whole-tree scan", () => {
    expect(describeToolCall("scan_secrets", { include: "src/**" })).toBe("src/**");
    expect(describeToolCall("scan_secrets", {})).toBe("");
  });

  it("shows the command itself, which is the whole point of approving it", () => {
    expect(describeToolCall("run_command", { command: "npm test -- --watch=false" })).toBe("npm test -- --watch=false");
  });

  it("never dumps a file's contents just because they were an argument", () => {
    // write_file carries the entire file in `content`; printing it would bury the transcript.
    const described = describeToolCall("write_file", { path: "big.ts", content: "x".repeat(50_000) });
    expect(described).toBe("big.ts");
  });

  it("counts a plan rather than listing it", () => {
    expect(describeToolCall("todo_write", { items: ["a", "b", "c"] })).toBe("3 steps");
    expect(describeToolCall("todo_write", { items: ["a"] })).toBe("1 step");
    expect(describeToolCall("todo_write", { start: [1], complete: [2, 3] })).toBe("1 started, 2 done");
  });

  it("defaults a listing with no path to the project root", () => {
    expect(describeToolCall("list_files", {})).toBe(".");
  });

  it("returns nothing for a tool that genuinely has no argument", () => {
    expect(describeToolCall("todo_read", {})).toBe("");
  });

  it("falls back to the first string argument for a tool it does not know", () => {
    expect(describeToolCall("some_future_tool", { count: 3, target: "the thing" })).toBe("the thing");
    expect(describeToolCall("some_future_tool", { count: 3 })).toBe("");
  });
});

describe("summarizeToolResult", () => {
  it("reports a passing command as its exit code alone", () => {
    expect(summarizeToolResult("run_command", "exit 0\n3 tests passed", false)).toBe("exit 0");
  });

  it("carries the first line of a failing command's output, which is what gets read first", () => {
    const summary = summarizeToolResult("run_command", "exit 1\n\nTypeError: x is not a function", true);
    expect(summary).toContain("exit 1");
    expect(summary).toContain("TypeError");
  });

  it("counts matches, files, entries and lines rather than repeating them", () => {
    expect(summarizeToolResult("grep_files", "a.ts:1:x\nb.ts:2:y", false)).toBe("2 matches");
    expect(summarizeToolResult("grep_files", "a.ts:1:x", false)).toBe("1 match");
    expect(summarizeToolResult("glob_files", "a.ts\nb.ts\nc.ts", false)).toBe("3 files");
    expect(summarizeToolResult("read_file", "one\ntwo\nthree\n", false)).toBe("3 lines");
    expect(summarizeToolResult("list_files", "src/\nREADME.md", false)).toBe("2 entries");
  });

  it("says plainly when a search found nothing, instead of counting the apology", () => {
    expect(summarizeToolResult("grep_files", "No matches.", false)).toBe("no matches");
    expect(summarizeToolResult("glob_files", "No files matched.", false)).toBe("no files");
  });

  it("counts findings from a secret scan, or says the scan was clean", () => {
    expect(summarizeToolResult("scan_secrets", "No likely secrets found by pattern in the scanned files.", false)).toBe("clean");
    expect(summarizeToolResult("scan_secrets", "1 possible secret found by pattern — verify each; a pattern match is a lead, not proof.\nsrc/config.ts:1: AWS access key — AKIA…MNOP (20 chars)", false)).toBe("1 possible secret");
    expect(summarizeToolResult("scan_secrets", "2 possible secrets found by pattern — verify each; a pattern match is a lead, not proof.\n...", false)).toBe("2 possible secrets");
  });

  it("keeps a write or edit tool's own report, which is already exact", () => {
    expect(summarizeToolResult("write_file", "Wrote tetris.py (6249 bytes).", false)).toBe("Wrote tetris.py (6249 bytes).");
    expect(summarizeToolResult("edit_file", "Edited app.ts (2 replacements).", false)).toBe("Edited app.ts (2 replacements).");
  });

  it("reduces a checklist to its progress", () => {
    const todos = "[x] 1. read the config\n[~] 2. add the flag\n[ ] 3. run the tests";
    expect(summarizeToolResult("todo_write", todos, false)).toBe("1/3 done");
  });

  it("falls back to the first non-empty line for an unknown tool", () => {
    expect(summarizeToolResult("some_future_tool", "\n\nit worked\nmore detail", false)).toBe("it worked");
  });

  it("keeps a verified preview URL whole instead of abbreviating it away", () => {
    const started = summarizeToolResult(
      "start_application",
      "Application app-1 is running and answered HTTP at http://127.0.0.1:4173/. It will remain available while this Nova session is open.",
      false,
    );
    expect(started).toBe("ready at http://127.0.0.1:4173/");
    expect(started).not.toContain("…");
  });

  it("shows why a preview failed rather than a half-sentence", () => {
    const failed = summarizeToolResult("start_application", "Application exited before port 4173 became ready.\n\nRecent logs:\nboom", true);
    expect(failed).toContain("exited before port 4173");
    expect(failed).not.toContain("\n");
  });

  it("summarizes managed application status by state and reachable URL", () => {
    expect(summarizeToolResult("application_status", "No managed applications.", false)).toBe("none");
    expect(summarizeToolResult("application_status", "app-1: running at http://127.0.0.1:4173/ (port 4173)\nRecent logs:\nready", false))
      .toBe("running at http://127.0.0.1:4173/");
    expect(summarizeToolResult("application_status", "app-1: running at http://127.0.0.1:1/ (port 1)\n\napp-2: exited at http://127.0.0.1:2/ (port 2)", false))
      .toBe("2 applications");
  });

  it("names the port a preview was asked to bind, not just the command", () => {
    expect(describeToolCall("start_application", { command: "bun run dev", port: 4173 })).toBe("bun run dev :4173");
    expect(describeToolCall("stop_application", { id: "app-1" })).toBe("app-1");
    expect(describeToolCall("application_status", {})).toBe("");
  });

  it("never returns a multi-line summary, whatever the tool produced", () => {
    for (const name of ["run_command", "grep_files", "read_file", "write_file", "todo_write", "start_application", "application_status", "unknown"]) {
      const summary = summarizeToolResult(name, "first line\nsecond line\nthird", false);
      expect(summary, name).not.toContain("\n");
    }
  });
});
