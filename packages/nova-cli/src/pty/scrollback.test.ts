import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess, type SpawnNovaOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * Whether the terminal can still scroll back over the session.
 *
 * This is the one property no unit test can express, because it is not about what Nova prints — it
 * is about what the *terminal* does with what Nova printed. A terminal saves a scrolled-off line to
 * its scrollback only when the scrolling region is the entire screen; `DECSTBM`, which is how the
 * pinned footer reserved its rows, makes the region smaller than the screen and silently throws
 * every one of those lines away. The transcript looked perfect and the history was gone.
 *
 * So the assertion is on the escape sequence itself. `\x1b[<top>;<bottom>r` with a bottom short of
 * the last row is exactly the state that costs scrollback, and its absence is what a person
 * experiences as "I can scroll up again".
 */

const PROMPT = /›|auto >/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";
/** A scroll region that stops short of the last row. `\x1b[r` (reset to full screen) is harmless. */
const RESERVED_REGION = /\x1b\[\d+;\d+r/;

describe("scrollback, under a real pty", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-scroll-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-scroll-config-"));
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

  it("never reserves a scroll region, so the terminal keeps every line that scrolls past", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    // Enough output to actually scroll a 40-row window, since a region is only ever set once and
    // the cost of it only shows up when something scrolls.
    stub.enqueue({ kind: "text", text: Array.from({ length: 60 }, (_unused, index) => `line ${index}`).join("\n") });
    const before = p.output().length;
    p.writeLine("say a lot");
    await p.waitFor(/line 59/, { timeoutMs: 30_000, since: before });

    expect(p.output()).not.toMatch(RESERVED_REGION);
  }, 90_000);

  it("still shows the mode and the running cost, which is what the footer was for", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    // The information survives the footer's removal; only its fixed position does.
    expect(p.output()).toMatch(/auto/);
    expect(p.output()).toMatch(/\$0\.00/);
  }, 60_000);

  it("reserves the region only when the footer is explicitly asked for", async () => {
    const p = boot({ args: ["--pin"] });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    expect(p.output()).toMatch(RESERVED_REGION);
  }, 60_000);
});
