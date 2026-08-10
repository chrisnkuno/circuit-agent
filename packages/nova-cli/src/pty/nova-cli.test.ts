import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess, type SpawnNovaOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * End-to-end tests that drive the real `nova` binary under a real pseudo-terminal.
 *
 * Everything else in this package tests functions in isolation. None of that exercises what a
 * terminal actually does to a process: readline puts the tty into raw mode (which changes how
 * Ctrl+C reaches the process — see the comment on `bindSigint` in `nova.ts`), SIGWINCH fires on
 * resize, and multi-byte input arrives as raw bytes that have to survive echo. `child_process.spawn`
 * with piped stdio cannot stand in for any of this — `nova.ts` refuses to run interactively without
 * `process.stdin.isTTY` in the first place.
 *
 * The model is a local SSE stub (`anthropic-stub.ts`), not a mock inside the process: the CLI talks
 * to it over a real HTTP connection exactly as it would talk to Anthropic, via `ANTHROPIC_BASE_URL`.
 */

const PROMPT = /›/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";

describe("nova CLI under a real pty", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-pty-"));
    // Isolated from whatever real settings.json happens to exist on the machine running the
    // suite — without this, a developer's own saved API key could leak into a "test" run.
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-pty-config-"));
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
      // A currency the model's catalog price is already denominated in, and a fixed TZ: either
      // one left to the host's locale can make `resolveCurrencyPreference` decide a live FX fetch
      // is needed, which is either slow or fails outright on a network-less CI runner.
      args: ["--currency", "USD", ...(options.args ?? [])],
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

  describe("resize", () => {
    // A terminal window is resized mid-session constantly (a split pane, a maximized window); a
    // CLI that reads process.stdout.columns without expecting it to change under it is a CLI that
    // corrupts its own status bar the first time someone does this.
    it("survives a live resize and keeps responding to commands", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      p.resize(60, 15);
      await new Promise((resolve) => setTimeout(resolve, 200));
      p.resize(160, 50);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const before = p.output().length;
      p.writeLine("/help");
      await p.waitFor(/nova.*coding agent/i, { timeoutMs: 10_000, since: before });

      expect(p.output().slice(before)).not.toMatch(/uncaught|unhandled rejection/i);
    }, 30_000);
  });

  describe("unicode input", () => {
    // readline echoes as it goes, byte by byte in principle — a multi-byte UTF-8 character or an
    // astral-plane emoji split across a read boundary is exactly the kind of thing that renders as
    // a mangled replacement character instead of the character someone actually typed.
    it("echoes accented, CJK and emoji characters intact", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      const before = p.output().length;
      const message = "héllo 世界 🎉 — some naïve café";
      p.write(message);
      await p.waitFor("café", { timeoutMs: 10_000, since: before });

      expect(p.output().slice(before)).toContain(message);
    }, 30_000);
  });

  describe("Ctrl+C at an idle prompt", () => {
    // The everyday "I changed my mind" case: nothing is running, so this should behave like any
    // other terminal program — leave promptly, not print an error, not need a second Ctrl+C.
    it("exits cleanly with no turn in flight", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      p.write("\x03");
      const exit = await p.waitForExit(10_000);

      expect(exit.exitCode).toBe(0);
    }, 30_000);
  });

  describe("Ctrl+C mid-turn", () => {
    // `BoundedAgentRuntime` only checks for cancellation between iterations (see agent-runtime.ts)
    // — it does not abort an in-flight model call — so this cannot assert the stream stops on the
    // spot. What it can and must assert: `handleSigint` actually fires (see the readline-vs-process
    // "SIGINT" fix in nova.ts), the turn still finishes, and the CLI is genuinely usable afterward —
    // not merely printing "interrupted" while still stuck.
    it("survives an interrupt during a slow response and returns to a working prompt", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      stub.enqueue({ kind: "text", text: "This is a slow multi-chunk answer streamed back over several seconds.", chunkSize: 8, chunkDelayMs: 250 });
      const before = p.output().length;
      p.writeLine("tell me something slowly");
      await p.waitFor(/This is a/, { timeoutMs: 15_000, since: before });

      p.write("\x03");
      await p.waitFor(/interrupted/i, { timeoutMs: 5_000, since: before });

      const afterInterrupt = p.output().length;
      await p.waitFor(PROMPT, { timeoutMs: 15_000, since: afterInterrupt });

      // Usable, not just alive: the prompt reappearing could still be a readline artifact if the
      // agent were wedged underneath it. Only a fresh command actually completing proves otherwise.
      const afterPrompt = p.output().length;
      p.writeLine("/help");
      await p.waitFor(/nova.*coding agent/i, { timeoutMs: 10_000, since: afterPrompt });
    }, 60_000);
  });

  describe("tab switching", () => {
    // Tabs are sequential (tabs.ts): only one is ever "in front". The strip is the only signal a
    // person has that the command they just typed landed on the tab they meant it for.
    it("opens tabs, shows them in the strip, and moves the active marker with next/prev", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      // Exact cell text from `renderTabStrip` — not a bare `/\[3/`, which an ANSI cursor-position
      // code like `\x1b[3G` can satisfy by pure coincidence and turn this flaky.
      const firstTabIdle = ` 1 ${path.basename(cwd)} `;
      const secondTabActive = "[2 tab 2]";
      const secondTabIdle = " 2 tab 2 ";
      const thirdTabActive = "[3 tab 3]";

      let before = p.output().length;
      p.writeLine("/tab new");
      await p.waitFor(secondTabActive, { timeoutMs: 10_000, since: before });

      before = p.output().length;
      p.writeLine("/tab new");
      const afterSecondOpen = await p.waitFor(thirdTabActive, { timeoutMs: 10_000, since: before });
      const strip = afterSecondOpen.slice(before);
      expect(strip).toContain(firstTabIdle); // all three tabs present, not just the newest
      expect(strip).toContain(secondTabIdle);
      expect(strip).toContain(thirdTabActive); // and tab 3 — the one just opened — is the active one

      before = p.output().length;
      p.writeLine("/tab prev");
      await p.waitFor(secondTabActive, { timeoutMs: 10_000, since: before });

      before = p.output().length;
      p.writeLine("/tab next");
      await p.waitFor(thirdTabActive, { timeoutMs: 10_000, since: before });
    }, 40_000);
  });

  describe("an approval prompt interrupted by Ctrl+C", () => {
    // The bug this guards against: `agent.cancel()` alone only flips a flag `BoundedAgentRuntime`
    // checks between steps. The pending `readline.question()` behind the approval prompt is not a
    // step the runtime loops over, so without the fix in `createApprovalPrompt` (nova.ts) — racing
    // the question against an `AbortSignal` — Ctrl+C printed "interrupted" and then the process sat
    // there, still genuinely blocked on a y/n/a/d question nobody could answer anymore.
    it("does not hang — the turn is denied and the prompt comes back", async () => {
      const p = boot({ args: ["--build"] });
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      stub.enqueue({ kind: "tool_call", toolName: "run_command", input: { command: "echo hello-from-nova-test" } });
      const before = p.output().length;
      p.writeLine("run echo hello-from-nova-test");
      await p.waitFor(/Nova wants to/, { timeoutMs: 15_000, since: before });

      const beforeInterrupt = p.output().length;
      p.write("\x03");
      // The literal proof this is fixed: without it, this call times out with the [y]es/[n]o
      // question still the last thing on screen, exactly as observed before the fix was applied.
      await p.waitFor(PROMPT, { timeoutMs: 15_000, since: beforeInterrupt });

      expect(p.output().slice(beforeInterrupt)).toMatch(/rejected by the user|denied/i);
      expect(stub.requestCount()).toBe(1); // denied before any second round trip to the model

      // And genuinely usable afterward, the same standard as the mid-turn case above.
      const afterPrompt = p.output().length;
      p.writeLine("/help");
      await p.waitFor(/nova.*coding agent/i, { timeoutMs: 10_000, since: afterPrompt });
    }, 45_000);
  });

  describe("the pinned footer", () => {
    // Nova's transcript has always been an append-only scroll; this is the one thing that changed
    // about it — a fixed status/input footer carved off the bottom via the terminal's own
    // scroll-region margins (screen.ts), not an alternate-screen rewrite. These assert on the real
    // escape sequences a real terminal receives, not on the pure layout math `layout.test.ts` and
    // `screen.test.ts` already cover against a fake stream — that math could be correct and the
    // wiring into `nova.ts` still wrong.
    it("sets a scroll region excluding the bottom rows once the prompt is up", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      // rows=30 (the harness default), footer=2 (status + input) → scrollBottom=28 — see
      // computeLayout in layout.ts. A literal DECSTBM sequence is the only real proof the footer is
      // actually pinned, as opposed to merely printing a status-shaped line inline in the scroll.
      expect(p.output()).toMatch(/\x1b\[1;28r/);
    }, 30_000);

    it("separates the user's own message from the assistant's reply with distinct markers", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      stub.enqueue({ kind: "text", text: "The port is 3000." });
      const before = p.output().length;
      p.writeLine("what port does the app use");
      await p.waitFor("The port is 3000", { timeoutMs: 15_000, since: before });

      const turn = p.output().slice(before);
      // The user's request no longer merely echoes at the old prompt line — with the input row
      // moved into the fixed footer, it has to be deliberately re-printed into the transcript, and
      // this is the marker that proves that happened rather than the line silently disappearing.
      expect(turn).toMatch(/❯.*what port does the app use/);
      expect(turn).toMatch(/✦.*Nova/);
      // The assistant's own marker must come after the user's, not before — same order a reader
      // would expect a chat transcript to read in.
      expect(turn.indexOf("❯")).toBeLessThan(turn.indexOf("✦"));
    }, 30_000);

    it("reissues the scroll region at the new size on resize, not the stale one", async () => {
      const p = boot();
      await p.waitFor(PROMPT, { timeoutMs: 30_000 });

      const before = p.output().length;
      p.resize(100, 40); // scrollBottom = 40 - 2 = 38
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(p.output().slice(before)).toMatch(/\x1b\[1;38r/);
    }, 30_000);
  });
});
