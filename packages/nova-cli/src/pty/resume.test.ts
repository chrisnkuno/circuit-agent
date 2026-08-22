import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * What a resumed session looks like to someone sitting in front of it.
 *
 * `src/resume.test.ts` proves the mechanics — the right record is found, the transcript reaches
 * the model, the same file keeps being written. None of that is visible from the terminal, and a
 * resume you cannot see is one you have to take on faith: the screen is empty, the prompt looks
 * exactly like a fresh session's, and the usual way to check — scroll up — has nothing to scroll
 * to. This covers the part that is only true on a real tty.
 */

const PROMPT = /›|auto >/;

describe("resuming, from the terminal", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-pty-resume-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-pty-resume-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(args: string[] = []): NovaProcess {
    proc = spawnNova({
      cwd,
      args: ["--currency", "USD", ...args],
      cols: 120,
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: stub.url,
        NOVA_CONFIG_DIR: configDir,
        NOVA_FX_OFFLINE: "true",
        TZ: "UTC",
      },
    });
    return proc;
  }

  it("opens on the end of the conversation it resumed, not on an empty screen", async () => {
    stub.enqueue({ kind: "text", text: "The migration lives in db/0007-add-index.sql." });
    const first = boot();
    await first.waitFor(PROMPT, { timeoutMs: 60_000 });
    const asked = first.output().length;
    first.writeLine("where does the migration live?");
    await first.waitFor(/0007-add-index/, { timeoutMs: 40_000, since: asked });
    // The answer streaming and the turn's "completed" trailer are separate prints; leaving before
    // the second one means leaving with the turn technically in flight, and the session is only
    // written to disk once the turn ends.
    await first.waitFor(PROMPT, { timeoutMs: 20_000, since: asked });
    first.write("\x03"); // Ctrl+C at an idle prompt is the clean way out
    await first.waitForExit(20_000);

    const second = boot(["--resume"]);
    await second.waitFor(PROMPT, { timeoutMs: 60_000 });
    const screen = second.output();

    // Both halves matter: which session (so you can tell it picked the right one) and what was
    // said in it (so you can tell it actually loaded).
    expect(screen).toMatch(/Resumed \d{8}T\d{6}Z-/);
    expect(screen).toContain("where does the migration live?");
    expect(screen).toContain("0007-add-index");
  }, 120_000);

  it("keeps the past conversation out of the way of a one-shot run", async () => {
    // A replay is orientation for someone about to type. `nova --resume "…"` is not that: the
    // answer is the output, and the transcript in front of it is noise a script has to skip.
    stub.enqueue({ kind: "text", text: "The migration lives in db/0007-add-index.sql." });
    const first = boot();
    await first.waitFor(PROMPT, { timeoutMs: 60_000 });
    const asked = first.output().length;
    first.writeLine("where does the migration live?");
    await first.waitFor(/0007-add-index/, { timeoutMs: 40_000, since: asked });
    // The answer streaming and the turn's "completed" trailer are separate prints; leaving before
    // the second one means leaving with the turn technically in flight, and the session is only
    // written to disk once the turn ends.
    await first.waitFor(PROMPT, { timeoutMs: 20_000, since: asked });
    first.write("\x03"); // Ctrl+C at an idle prompt is the clean way out
    await first.waitForExit(20_000);

    stub.enqueue({ kind: "text", text: "Still db/0007-add-index.sql." });
    const oneShot = boot(["--resume", "and now?"]);
    await oneShot.waitFor(/Still db/, { timeoutMs: 60_000 });
    await oneShot.waitForExit(30_000);

    // The id line still names the session — that is the confirmation, and it carries the title,
    // which is the opening request. What must not appear is the replay itself: the earlier answer
    // and the transcript chrome around it.
    expect(oneShot.output()).toMatch(/Resumed \d{8}T\d{6}Z-/);
    expect(oneShot.output()).not.toContain("The migration lives in");
    expect(oneShot.output()).not.toContain("end of session");
  }, 120_000);
});
