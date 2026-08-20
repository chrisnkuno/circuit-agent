import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * What a first session tells you about staying in control of it.
 *
 * Every command Nova has is discoverable — through `/help`, the palette, the guide. Discoverable is
 * not the same as discovered: someone opening this for the first time sees a prompt, and nothing
 * on screen says that the agent's edits can be inspected or taken back. The commands that answer
 * that are the ones worth spending a line on, and this is the line.
 */

const PROMPT = /›|auto >/;

describe("what a first session points at", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-pty-first-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-pty-first-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(): NovaProcess {
    proc = spawnNova({
      cwd,
      cols: 110,
      args: ["--currency", "USD"],
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

  it("names the way out of being lost, and the way to undo, before anything is typed", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const screen = p.output();

    expect(screen).toContain("/help");
    // The two that make trying anything else safe: see what it did, and put it back.
    expect(screen).toContain("/diff");
    expect(screen).toContain("/undo");
  }, 120_000);

  it("stops offering the reminder once the session is under way", async () => {
    // A tip bar that never goes away is one people learn to look past, and by then it is occupying
    // the row where something that mattered could have gone.
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });

    const afterBoot = p.output().length;
    stub.enqueue({ kind: "text", text: "Done." });
    p.writeLine("say something");
    await p.waitFor(/Done\./, { timeoutMs: 40_000, since: afterBoot });
    await p.waitFor(PROMPT, { timeoutMs: 20_000, since: afterBoot });

    expect(p.output().slice(afterBoot)).not.toContain("take it back");
  }, 120_000);

  it("marks the essentials in /help, with a legend for the mark", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });

    const before = p.output().length;
    p.writeLine("/help");
    await p.waitFor(/start with these/, { timeoutMs: 20_000, since: before });

    const help = p.output().slice(before);
    // The mark has to reach the terminal, not merely exist in the string the renderer built.
    expect(help).toMatch(/[✦*]\s*\/(help|diff|mode|cost|model|exit)/);
  }, 120_000);
});
