import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * Choosing the update policy, in a real terminal.
 *
 * The unit tests decide when Nova may update itself; this proves the decision is reachable from the
 * prompt and that the answer outlives the session that gave it. Deliberately no network: the
 * registry path refuses anything but HTTPS, so a stub would test the stub. What is worth proving
 * here is that a preference typed once is still true tomorrow.
 */

const PROMPT = /›|auto >/;

describe("choosing how Nova updates itself", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-pty-update-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-pty-update-config-"));
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
        // Off for the session itself: a test must not reach a real registry, and the startup round
        // is exactly what this setting turns off.
        NOVA_AUTO_UPDATE: "off",
        TZ: "UTC",
      },
    });
    return proc;
  }

  it("remembers the policy in a file the next launch reads", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const since = p.output().length;
    p.writeLine("/update auto");
    await p.waitFor(/install automatically/i, { since, timeoutMs: 30_000 });

    const settings = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8")) as Record<string, string>;
    expect(settings.NOVA_AUTO_UPDATE).toBe("install");
  });

  it("says what the choices are rather than guessing at a word it does not know", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const since = p.output().length;
    p.writeLine("/update sometimes");
    await p.waitFor(/\/update auto/, { since, timeoutMs: 30_000 });
    const screen = p.output().slice(since);
    expect(screen).toMatch(/\/update off/);
    // Nothing was decided on the user's behalf.
    await expect(readFile(path.join(configDir, "settings.json"), "utf8").catch(() => "{}"))
      .resolves.not.toContain("NOVA_AUTO_UPDATE");
  });
});
