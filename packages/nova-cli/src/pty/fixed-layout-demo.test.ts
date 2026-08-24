import { fileURLToPath } from "node:url";
import path from "node:path";
import * as pty from "node-pty";
import { describe, expect, it } from "vitest";
import { bunExecutable } from "./harness";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const DEMO_ENTRY = path.join(REPO_ROOT, "tooling/dev/fixed-layout-demo.ts");

function spawnDemo(options: { cols?: number; rows?: number; quiet?: boolean } = {}) {
  const proc = pty.spawn(bunExecutable(), ["run", DEMO_ENTRY, ...(options.quiet ? ["--quiet"] : [])], {
    name: "xterm-color",
    cols: options.cols ?? 80,
    rows: options.rows ?? 20,
    cwd: REPO_ROOT,
    env: process.env as Record<string, string>,
  });
  let output = "";
  proc.onData((chunk) => { output += chunk; });

  const waitFor = (pattern: string | RegExp, timeoutMs = 5_000): Promise<string> => {
    const matches = () => typeof pattern === "string" ? output.includes(pattern) : pattern.test(output);
    if (matches()) return Promise.resolve(output);
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (!matches()) return;
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(output);
      }, 10);
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${String(pattern)} in:\n${JSON.stringify(output.slice(-4_000))}`));
      }, timeoutMs);
    });
  };

  const waitForOutputAfter = (offset: number, timeoutMs = 5_000): Promise<string> => {
    if (output.length > offset) return Promise.resolve(output);
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.length <= offset) return;
        clearInterval(timer);
        clearTimeout(timeout);
        resolve(output);
      }, 10);
      const timeout = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for PTY output after byte ${offset}.`));
      }, timeoutMs);
    });
  };

  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => proc.onExit(resolve));
  return { proc, waitFor, waitForOutputAfter, output: () => output, exited };
}

describe("the runnable fixed-layout demo", () => {
  it("survives navigation, resize, search, and restores the terminal on quit", async () => {
    const demo = spawnDemo({ cols: 80, rows: 20 });
    try {
      await demo.waitFor("streamed line 1");

      const beforePageUp = demo.output().length;
      demo.proc.write("\u001b[5~");
      await demo.waitFor(/back to live/, 2_000);
      const afterPageUp = demo.output().length;
      await demo.waitForOutputAfter(afterPageUp, 2_000);
      const whileScrolled = demo.output().slice(beforePageUp);
      expect(whileScrolled).toContain("back to live");
      expect(whileScrolled).not.toContain("streamed line 2");

      const beforeResize = demo.output().length;
      demo.proc.resize(52, 14);
      await demo.waitForOutputAfter(beforeResize, 2_000);
      expect(demo.output().slice(beforeResize)).toContain("Nova — fixed layout demo");

      // One write deliberately exercises PTY coalescing: terminals are byte streams and may hand
      // the opener, query and Enter to the process as one data event.
      demo.proc.write("/TypeError\r");
      await demo.waitFor(/\d+\/12 for "TypeError" {3}end:/, 5_000);

      demo.proc.write("q");
      await expect(demo.exited).resolves.toMatchObject({ exitCode: 0 });
      expect(demo.output()).toContain("\u001b[?1006l\u001b[?1000l");
      expect(demo.output()).toContain("\u001b[?25h\u001b[?1049l");
    } finally {
      try { demo.proc.kill(); } catch { /* It already exited. */ }
    }
  }, 15_000);
});
