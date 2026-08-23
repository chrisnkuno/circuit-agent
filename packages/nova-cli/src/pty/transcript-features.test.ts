import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess, type SpawnNovaOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * The reading experience, driven through a real terminal.
 *
 * Everything these features do is decided by pure functions covered elsewhere; what a pty adds is
 * the only question those tests cannot answer — whether the CLI actually *reaches* them. A code
 * panel that renders perfectly in a unit test and is never printed because the event never carried
 * the arguments is exactly the failure this catches.
 */

const PROMPT = /›|auto >/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";

/**
 * Assertions read the transcript the way a person does — colour is not content. Waiting patterns,
 * on the other hand, run against the raw buffer, so they must never straddle a colour boundary.
 */
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("what the transcript shows, under a real pty", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-view-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-view-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(options: Partial<SpawnNovaOptions> = {}): NovaProcess {
    proc = spawnNova({
      cwd,
      cols: 100,
      rows: 40,
      args: ["--currency", "USD", "--auto", ...(options.args ?? [])],
      env: {
        ANTHROPIC_API_KEY: ANTHROPIC_TEST_KEY,
        ANTHROPIC_BASE_URL: stub.url,
        NOVA_CONFIG_DIR: configDir,
        NOVA_FX_OFFLINE: "true",
        TZ: "UTC",
        ...options.env,
      },
    });
    return proc;
  }

  it("shows the measured reliability direction on every interactive startup", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const output = plain(p.output());
    expect(output).toMatch(/reliability \d+\/100/);
    expect(output).toContain("improving toward best-in-class");
  }, 60_000);

  it("shows the code a write actually contained, not only that a write happened", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    stub.enqueue({
      kind: "tool_call",
      toolName: "write_file",
      input: {
        path: "hello.ts",
        content: 'export const greeting = "hi";\nexport const answer = 42;\n',
      },
    });
    stub.enqueue({ kind: "text", text: "Done." });

    // Waiting on a span that syntax highlighting does not colour part-way through: `42` arrives
    // wrapped in its own escape codes, so `answer = 42` never appears contiguously in the raw pty
    // buffer even though that is exactly what the terminal draws.
    p.writeLine("write the greeting file");
    await p.waitFor(/answer = /, { timeoutMs: 30_000 });
    await p.waitFor(/summary/, { timeoutMs: 30_000 });
    const output = plain(p.output());
    expect(output).toContain("hello.ts");
    expect(output).toContain("tool activity");
    expect(output).toContain("new file");
    expect(output).toContain("summary");
    expect(output).toContain('greeting = "hi";');
    expect(output).toContain("answer = 42;");
    // Numbered, because the next thing anyone says about written code is a line number.
    expect(output).toMatch(/1\s+export const greeting/);
    expect(output.indexOf("tool activity")).toBeLessThan(output.indexOf("new file"));
    expect(output.indexOf("new file")).toBeLessThan(output.lastIndexOf("summary"));
  }, 60_000);

  it("folds a long write and expands it again on request, in the same scrolling transcript", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const content = Array.from(
      { length: 60 },
      (_unused, index) => `const value${index} = ${index};`,
    ).join("\n");
    stub.enqueue({
      kind: "tool_call",
      toolName: "write_file",
      input: { path: "big.ts", content },
    });
    stub.enqueue({ kind: "text", text: "Written." });

    const turnStarted = p.output().length;
    p.writeLine("write the big file");
    await p.waitFor(/more lines hidden/, {
      timeoutMs: 30_000,
      since: turnStarted,
    });
    expect(p.output()).not.toContain("value59");

    // The folded panel is printed during the tool call, before the model's final response and the
    // prompt. Sending /expand at that intermediate frame becomes input to the active turn rather
    // than the next command, so wait until Nova is ready to read it.
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: turnStarted });

    const before = p.output().length;
    p.writeLine("/expand");
    await p.waitFor(/value59/, { timeoutMs: 20_000, since: before });
  }, 60_000);

  it("remembers a fact typed with # and keeps it in a file the user can read", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    p.writeLine("# we use bun, not npm");
    await p.waitFor(/remembered/, { timeoutMs: 20_000 });
    const stored = await readFile(path.join(cwd, ".nova", "memory.md"), "utf8");
    expect(stored).toContain("- we use bun, not npm");

    const before = p.output().length;
    p.writeLine("/memory");
    await p.waitFor(/project memory/, { timeoutMs: 20_000, since: before });
    expect(p.output().slice(before)).toContain("we use bun, not npm");
  }, 60_000);

  it("draws with ASCII only when the terminal is declared unable to do better", async () => {
    const p = boot({ args: ["--ascii"] });
    // Waits for the input bar, which is the last thing drawn — assert any earlier and the banner
    // may not have finished printing, so "no non-ASCII yet" would mean "not yet drawn".
    //
    // It waits on the *bar*, not on "auto >", because the prompt has not looked like that since the
    // input line gained a box: the mode moved to the status line and the caret now sits inside a
    // frame, as `| >`. The old pattern could therefore never match, and the test timed out for
    // thirty seconds before failing — reported as a broken ASCII mode when ASCII mode was fine.
    // Both cells are coloured separately, hence the escapes between them.
    await p.waitFor(/\|(?:\x1b\[[0-9;]*m)*\s*(?:\x1b\[[0-9;]*m)*>/, {
      timeoutMs: 30_000,
    });
    const banner = p.output();
    // Nothing above the ASCII range reaches a terminal that asked for ASCII.
    const nonAscii = [
      ...new Set(
        [...banner].filter(
          (character) => (character.codePointAt(0) ?? 0) > 127,
        ),
      ),
    ];
    expect(nonAscii).toEqual([]);
  }, 60_000);

  it("reports and changes the spending pace without ending the session", async () => {
    const p = boot({ args: ["--slow"] });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const before = p.output().length;
    p.writeLine("/slow");
    await p.waitFor(/model rounds/, { timeoutMs: 20_000, since: before });

    const afterShow = p.output().length;
    p.writeLine("/slow off");
    await p.waitFor(/full speed/, { timeoutMs: 20_000, since: afterShow });
  }, 60_000);
});
