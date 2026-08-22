import { describe, expect, it } from "vitest";
import type { InteractiveCodingSandboxProvider } from "./providers/contracts";
import { DEFAULT_IGNORED_DIRECTORIES, listSandboxFiles, searchSandboxText } from "./sandbox-search";

/**
 * Searching inside a sandbox, where the tools may not be the ones you expect.
 *
 * Two failures shape this module and so shape these tests. `rg` is not in every image, and exiting
 * 127 must fall back to reading rather than reporting an empty workspace — "no matches" and "the
 * search never ran" look identical to a model and lead it to the wrong conclusion with confidence.
 * And `rg` exits 1 when it simply found nothing, which is not an error at all.
 */

type Command = { program: string; args: string[] };

/** A sandbox whose command results are scripted, recording exactly what was asked of it. */
function sandbox(handler: (command: Command) => { exitCode: number; stdout: string; stderr: string }, files: Record<string, string> = {}) {
  const commands: Command[] = [];
  const provider = {
    async runCommand(_id: string, command: { program: string; args: string[] }) {
      commands.push({ program: command.program, args: command.args });
      return handler({ program: command.program, args: command.args });
    },
    async readFile(_id: string, path: string) {
      const contents = files[path];
      if (contents === undefined) throw new Error(`no such file ${path}`);
      return contents;
    },
    async createSandbox() { throw new Error("unused"); },
    async suspendSandbox() {},
    async stopSandbox() {},
    async writeFile() {},
  } as unknown as InteractiveCodingSandboxProvider;
  return { provider, commands };
}

describe("listing files in a sandbox", () => {
  it("excludes every ignored directory in the find it issues", () => {
    const { provider, commands } = sandbox(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    return listSandboxFiles(provider, "sbx", "/workspace").then(() => {
      const args = commands[0].args.join(" ");
      for (const directory of DEFAULT_IGNORED_DIRECTORIES) expect(args, directory).toContain(`*/${directory}/*`);
    });
  });

  it("returns nothing rather than throwing when find fails", async () => {
    const { provider } = sandbox(() => ({ exitCode: 1, stdout: "", stderr: "find: permission denied" }));
    await expect(listSandboxFiles(provider, "sbx", "/workspace")).resolves.toEqual([]);
  });

  it("trims the output into real paths", async () => {
    const { provider } = sandbox(() => ({ exitCode: 0, stdout: "/workspace/a.ts\n/workspace/b.ts\n\n", stderr: "" }));
    await expect(listSandboxFiles(provider, "sbx", "/workspace")).resolves.toEqual(["/workspace/a.ts", "/workspace/b.ts"]);
  });
});

describe("searching text in a sandbox", () => {
  const options = (provider: InteractiveCodingSandboxProvider) => ({ sandbox: provider, sandboxId: "sbx", root: "/workspace", query: "needle" });

  it("reads ripgrep's output into matches with paths relative to the root", async () => {
    const { provider, commands } = sandbox(() => ({ exitCode: 0, stdout: "/workspace/src/a.ts:12:const needle = 1;\n", stderr: "" }));
    const matches = await searchSandboxText(options(provider));
    expect(matches).toEqual([{ path: "src/a.ts", line: 12, text: "const needle = 1;" }]);
    // A literal query must not be interpreted as a pattern.
    expect(commands[0].args).toContain("--fixed-strings");
  });

  it("treats 'found nothing' as an answer, not a failure", async () => {
    // rg exits 1 when there are no matches. Throwing there would turn every empty search into an error.
    const { provider } = sandbox(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    await expect(searchSandboxText(options(provider))).resolves.toEqual([]);
  });

  it("falls back to reading files when the image has no ripgrep", async () => {
    // Reporting "no matches" because the tool is missing is the worst failure available here: the
    // model believes the workspace does not contain what it is looking for.
    const { provider, commands } = sandbox(
      (command) => (command.program === "rg"
        ? { exitCode: 127, stdout: "", stderr: "rg: not found" }
        : { exitCode: 0, stdout: "/workspace/src/a.ts\n", stderr: "" }),
      { "/workspace/src/a.ts": "line one\nconst needle = 2;\n" },
    );
    const matches = await searchSandboxText(options(provider));
    expect(matches).toEqual([{ path: "src/a.ts", line: 2, text: "const needle = 2;" }]);
    expect(commands.map((command) => command.program)).toContain("find");
  });

  it("surfaces a real ripgrep error instead of silently returning nothing", async () => {
    const { provider } = sandbox(() => ({ exitCode: 2, stdout: "", stderr: "regex parse error" }));
    await expect(searchSandboxText({ ...options(provider), regex: true })).rejects.toThrow(/regex parse error/);
  });

  it("stops at the match ceiling instead of returning an unbounded list", async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `/workspace/f.ts:${index + 1}:needle`).join("\n");
    const { provider } = sandbox(() => ({ exitCode: 0, stdout: lines, stderr: "" }));
    const matches = await searchSandboxText({ ...options(provider), maxMatches: 25 });
    expect(matches).toHaveLength(25);
  });
});
