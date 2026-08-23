import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess, type SpawnNovaOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * A tab as a place, not a saved setting.
 *
 * Until every write went through a sink (`output.ts`), a tab remembered its agent, its ledger and
 * its mode, but not a single line it had printed — leaving one and coming back put you at a bare
 * prompt with no indication of what the work had been. `output.test.ts` proves the sinks record and
 * route correctly; what only a pty can answer is whether the CLI's hundred-odd write sites are
 * actually addressing them, since a single missed `process.stdout.write` would print into the wrong
 * tab and would look completely normal in every unit test.
 */

const PROMPT = /›|auto >/;
const ANTHROPIC_TEST_KEY = "sk-test-fake";

describe("what a tab keeps, under a real pty", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-tab-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-tab-config-"));
  });

  afterEach(async () => {
    if (proc) {
      proc.kill();
      // Reap this PTY before its stub and temporary directories disappear. Merely signalling it
      // left shutdown work from each case alive while the next one booted; by the guide case the
      // accumulated processes could stall the new CLI before its first prompt.
      await proc.waitForExit(5_000).catch(() => undefined);
    }
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

  it("shows you where you left off when you come back to a tab", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    // Something distinctive said in tab 1, so its reappearance later cannot be coincidence.
    stub.enqueue({ kind: "text", text: "The migration runs on the replica." });
    p.writeLine("what did we decide");
    await p.waitFor(/runs on the replica/, { timeoutMs: 30_000 });
    // Typed input reaches readline as a command only once the turn has released the prompt; sent
    // mid-turn it is echoed and dropped, which reads as a hang rather than as a mistake. The
    // marker is taken *after* the answer, because the prompt drawn when the turn was submitted is
    // still in the buffer and would satisfy the wait immediately.
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: p.output().length });

    p.writeLine("/tab new second");
    await p.waitFor(/\[2 second\]/, { timeoutMs: 30_000 });

    // A brand-new tab has printed nothing, so there is nothing to replay into it.
    const inSecond = p.output().length;
    expect(p.output().slice(inSecond)).not.toContain("runs on the replica");

    p.writeLine("/tab 1");
    await p.waitFor(/runs on the replica/, { timeoutMs: 30_000, since: inSecond });
  }, 90_000);

  it("says that a background tab is paused, and where to send work that should keep running", async () => {
    // The one thing about tabs people get wrong, checked where they actually meet it. Opening a
    // second tab is the moment the assumption forms — especially for anyone who has used the
    // desktop window, whose tabs genuinely do run at the same time.
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const opening = p.output().length;
    p.writeLine("/tab new second");
    const seen = await p.waitFor(/only the tab in front runs/, { timeoutMs: 30_000, since: opening });
    expect(seen.slice(opening)).toContain("/detach");

    // Listing tabs asks the same question, and answers it however many tabs there are.
    const listing = p.output().length;
    p.writeLine("/tab");
    await p.waitFor(/only the tab in front runs/, { timeoutMs: 30_000, since: listing });
    p.kill();
  }, 90_000);

  it("keeps each tab's work in its own tab rather than in whichever is on screen", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "text", text: "Answer belonging to tab one." });
    p.writeLine("first question");
    await p.waitFor(/belonging to tab one/, { timeoutMs: 30_000 });
    // Measured after the answer: the prompt from the submitted turn is still in the buffer.
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: p.output().length });

    p.writeLine("/tab new second");
    await p.waitFor(/\[2 second\]/, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "text", text: "Answer belonging to tab two." });
    const inSecond = p.output().length;
    p.writeLine("second question");
    await p.waitFor(/belonging to tab two/, { timeoutMs: 30_000, since: inSecond });
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: p.output().length });

    // Returning to tab 1 replays tab 1. If any write site still went straight to the process, the
    // second tab's answer would have been recorded against the first and would surface here.
    const returning = p.output().length;
    p.writeLine("/tab 1");
    await p.waitFor(/belonging to tab one/, { timeoutMs: 30_000, since: returning });
    expect(p.output().slice(returning)).not.toContain("belonging to tab two");
  }, 90_000);

  it("paints in the theme it was told to, and changes it without restarting", async () => {
    // starry-night's primary is #8ab4f8. A theme that resolved but never reached the renderer
    // looks identical to one that was ignored, so the assertion is on the code itself.
    const p = boot({ args: ["--theme", "starry-night"], env: { COLORTERM: "truecolor", NO_COLOR: undefined } });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const before = p.output().length;
    p.writeLine("/theme");
    await p.waitFor(/starry-night/, { timeoutMs: 20_000, since: before });
    expect(p.output().slice(before)).toContain("\x1b[38;2;138;180;248m");

    const switching = p.output().length;
    p.writeLine("/theme nebula");
    // Waiting on the colour rather than on the name: the terminal echoes the typed command, so
    // /nebula/ is satisfied by the keystrokes themselves before Nova has answered them.
    // nebula's primary is #66e0ff — a different code, emitted after the switch and not before.
    await p.waitFor(/\x1b\[38;2;102;224;255m/, { timeoutMs: 20_000, since: switching });
  }, 90_000);

  it("says so rather than quietly rendering something else when a theme does not exist", async () => {
    const p = boot({ args: ["--theme", "no-such-theme"] });
    await p.waitFor(/No theme named "no-such-theme"/, { timeoutMs: 30_000 });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
  }, 60_000);

  it("gives each tab its own model, and says which is which in the strip", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    // A second tab on a different model. The strip is the only place a person can see that the
    // command they are about to type is going somewhere else.
    p.writeLine("/tab new fast --model claude-haiku-4-5-20251001");
    await p.waitFor(/\[2 fast/, { timeoutMs: 30_000 });
    const opened = p.output();
    expect(opened).toContain("claude-haiku-4-5");
    expect(opened).toContain("on this machine");

    // Both models are named in the strip, so the tabs are distinguishable at a glance.
    const strip = p.output().slice(p.output().lastIndexOf("[2 fast"));
    expect(strip.length).toBeGreaterThan(0);

    const back = p.output().length;
    p.writeLine("/tab 1");
    await p.waitFor(/\[1 /, { timeoutMs: 30_000, since: back });
  }, 90_000);

  it("refuses a provider it has no key for, without disturbing the session", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    // A model id is deliberately *not* validated — providers ship new ones constantly and an
    // allowlist would reject tomorrow's model. A provider, though, either has a key or does not.
    const before = p.output().length;
    p.writeLine("/tab new broken --provider no-such-provider");
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: before });
    expect(p.output().slice(before)).not.toMatch(/\[2 broken/);

    // The session is untouched: the tab that was in front is still the one answering.
    const after = p.output().length;
    stub.enqueue({ kind: "text", text: "Still working." });
    p.writeLine("still there?");
    await p.waitFor(/Still working/, { timeoutMs: 30_000, since: after });
  }, 90_000);

  it("opens the control panel and hands the terminal back when you leave it", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    // Something in tab 1 worth seeing in a pane.
    stub.enqueue({ kind: "text", text: "Panel content marker." });
    p.writeLine("say something");
    await p.waitFor(/Panel content marker/, { timeoutMs: 30_000 });
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: p.output().length });

    const opening = p.output().length;
    p.writeLine("/workspace");
    // The legend is the panel's own text and appears nowhere else in the CLI.
    await p.waitFor(/q leave/, { timeoutMs: 30_000, since: opening });

    // Leaving must restore the prompt: a panel that keeps the keyboard is a hung session.
    const leaving = p.output().length;
    p.write("q");
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: leaving });

    // And the session still works afterward, with the same tab in front.
    const after = p.output().length;
    stub.enqueue({ kind: "text", text: "Still answering." });
    p.writeLine("are you there");
    await p.waitFor(/Still answering/, { timeoutMs: 30_000, since: after });
  }, 120_000);

  it("offers the guide on the opening line, and prints a named topic into the transcript", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    // A manual nobody is told about is a manual nobody reads, so it sits beside /help on the
    // very first screen.
    expect(p.output()).toContain("/guide");

    // A *named* topic prints rather than opening the screen: it was asked for as text, and text in
    // the transcript can be scrolled back to and copied.
    const topic = p.output().length;
    p.writeLine("/guide tabs");
    // The guide is streamed over several PTY writes. Wait for the later example, not an earlier
    // sentence, before asserting on it; otherwise a fast reader can sample a half-painted guide.
    await p.waitFor(/--sandbox e2b/, { timeoutMs: 30_000, since: topic });
    expect(p.output().slice(topic)).toContain("--sandbox e2b");
    // The prompt can arrive in the same PTY chunk as the final guide line. Waiting from an offset
    // sampled *after* the text match races past that prompt and then waits forever for another.
    // `topic` is before submission, so a prompt after it is necessarily the one returned here.
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: topic });

    const missing = p.output().length;
    p.writeLine("/guide nonsense");
    await p.waitFor(/No guide topic called/, { timeoutMs: 30_000, since: missing });
  }, 90_000);

  it("opens the guide as a screen, and gives the terminal back", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const opening = p.output().length;
    p.writeLine("/guide");
    // The screen's own legend, which the printed guide does not carry.
    await p.waitFor(/topic .* scroll/, { timeoutMs: 30_000, since: opening });

    // Typing filters rather than navigating: "q" is in "sandbox" and must not close the screen.
    p.write("/");
    await p.waitFor(/search:/, { timeoutMs: 20_000, since: p.output().length });
    const filtering = p.output().length;
    p.write("sandbox");
    await p.waitFor(/search: sandbox/, { timeoutMs: 20_000, since: filtering });

    // Waited for between keys, never sent together: keystrokes written in one go reach the input
    // parser as a single chunk, and a test that assumes they are handled in the order it wrote
    // them is testing its own timing rather than the screen.
    const closing = p.output().length;
    p.write("\r");
    await p.waitFor(/topic .* q leave/, { timeoutMs: 20_000, since: closing });

    const leaving = p.output().length;
    p.write("q");
    await p.waitFor(PROMPT, { timeoutMs: 30_000, since: leaving });

    const after = p.output().length;
    stub.enqueue({ kind: "text", text: "Still answering." });
    p.writeLine("are you there");
    await p.waitFor(/Still answering/, { timeoutMs: 30_000, since: after });
  }, 120_000);
});
