import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasShellSyntax, runLocalCommand, tokenizeCommand } from "./command";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-command-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("local command executor", () => {
  it("uses argv semantics for ordinary commands and preserves quoted arguments", async () => {
    expect(tokenizeCommand('node -e "console.log(123)"')).toEqual(["node", "-e", "console.log(123)"]);
    expect(hasShellSyntax('node -e "console.log(123)"')).toBe(false);
    const result = await runLocalCommand("printf %s direct", { cwd: root, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "direct" });
  });

  it("uses the explicit shell path only when syntax requires it", async () => {
    expect(hasShellSyntax("printf first && printf second")).toBe(true);
    const result = await runLocalCommand("printf first && printf second", { cwd: root, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "firstsecond" });
  });

  it("terminates a timed-out process with a classified exit code", async () => {
    const result = await runLocalCommand('node -e "setTimeout(() => {}, 10000)"', { cwd: root, timeoutMs: 20 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("exceeded 20ms");
  });
});
