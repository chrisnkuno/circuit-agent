import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnNova } from "./harness";

/**
 * The suggestion dropup and the Ctrl chord layer, against a real terminal.
 *
 * Both are terminal properties that no unit test can state. The dropup's geometry is unit-tested
 * against a fake stream, but what that cannot show is the thing it was built to fix: the list only
 * ever appeared under `--pin`, because it addressed rows by absolute screen coordinates that are
 * only correct when a held scroll region has pinned the bar to a known row. Every session here boots
 * *without* `--pin` — the default, and the configuration where the list used to be missing entirely.
 *
 * The chord layer is terminal-only for a different reason: Ctrl+A and Ctrl+W are readline's own
 * editing keys, so whether a chord wins is a question about two keypress listeners on one stdin, and
 * about whether the line readline edited underneath us is still replaced correctly.
 */

const CTRL_A = "\x01";
const CTRL_W = "\x17";
const CTRL_S = "\x13";
const CTRL_G = "\x07";
const ESCAPE = String.fromCharCode(27);

let stub: AnthropicStub; let cwd: string;
beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-dropup-"));
});
afterAll(async () => { await stub.close(); });

/** An ordinary inline session: no `--pin`, which is what nearly every real session is. */
async function boot(rows = 30) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-dropupcfg-"));
  const p = spawnNova({ cwd, rows, args: ["--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
    NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC",
  }});
  await p.waitFor(/›/, { timeoutMs: 30_000 });
  return p;
}

describe("the suggestion dropup, without a pinned footer", () => {
  it("lists matching commands with their descriptions as a name is typed", async () => {
    // The regression this pins: inline sessions used to get ghost text and nothing else, because
    // the only list renderer refused to draw without reserved rows.
    const p = await boot();
    const mark = p.output().length;
    p.write("/mod");
    const seen = await p.waitFor(/permission mode/, { timeoutMs: 15_000, since: mark });
    const frame = seen.slice(mark);
    expect(frame).toContain("/mode");
    expect(frame).toContain("/model");
    p.kill();
  }, 60_000);

  it("draws the list above the bar, in the rows readline never erases", async () => {
    // Readline refreshes its line with an `ED 0` from the input row, destroying everything below it.
    // The list is printed *before* the bar's top border for exactly that reason, and the byte order
    // is where that ordering is observable.
    const p = await boot();
    const mark = p.output().length;
    p.write("/mod");
    await p.waitFor(/permission mode/, { timeoutMs: 15_000, since: mark });
    // `waitFor` resolves the instant the list row lands, which is *before* the bar that follows it
    // has been written — settle first, or the frame under test is half a block.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const frame = p.output().slice(mark);
    // First occurrence of each, which is the one block print. Later occurrences are the in-place
    // repaints that follow, and they are emitted in the opposite order by construction.
    const listRow = frame.indexOf("permission mode");
    // The bar's own caret, drawn as part of the block that follows the list.
    const barCaret = frame.indexOf("›");
    expect(listRow).toBeGreaterThan(-1);
    expect(barCaret).toBeGreaterThan(listRow);
    p.kill();
  }, 60_000);

  it("shows the chord beside a command that has one", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/wan");
    const seen = await p.waitFor(/Ctrl\+W/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("/wander");
    p.kill();
  }, 60_000);

  it("never swallows the line, so the command being typed still runs", async () => {
    // The load-bearing property. A list that took the keyboard on "/" would eat the rest of this
    // line into a query, and the command would never run at all.
    const p = await boot();
    const mark = p.output().length;
    p.write("/mode plan\r");
    const seen = await p.waitFor(/plan/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("plan");
    p.kill();
  }, 60_000);

  it("takes the list down again when the line stops being a command", async () => {
    // Backspacing out of "/" must reclaim the rows, or the bar is left sitting on a stale menu.
    const p = await boot();
    const mark = p.output().length;
    p.write("/mod");
    await p.waitFor(/permission mode/, { timeoutMs: 15_000, since: mark });
    const cleared = p.output().length;
    p.write("\x7f\x7f\x7f\x7f");
    // The block is reprinted without the list; the erase is what proves the rows came back.
    const seen = await p.waitFor(/\x1b\[0J/, { timeoutMs: 15_000, since: cleared });
    expect(seen.length).toBeGreaterThan(cleared);
    p.kill();
  }, 60_000);

  it("declines to draw at all on a terminal with no room to spare", async () => {
    // A list that covers the transcript it is being read against has optimised the wrong thing —
    // and on a terminal this short there is nothing left after the bar's own three rows.
    const p = await boot(6);
    const mark = p.output().length;
    p.write("/mod");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(p.output().slice(mark)).not.toContain("permission mode");
    p.kill();
  }, 60_000);
});

describe("the Ctrl chord layer", () => {
  it("switches mode on Ctrl+A, replacing whatever was half-typed", async () => {
    // Two properties at once: the chord beats readline's own Ctrl+A (move to column zero), and the
    // half-typed line is replaced rather than having the command prepended to it.
    const p = await boot();
    const mark = p.output().length;
    p.write("write a test for the parser");
    p.write(CTRL_A);
    const seen = await p.waitFor(/auto/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("auto");
    expect(seen.slice(mark)).not.toContain("/autowrite");
    p.kill();
  }, 60_000);

  it("opens settings on Ctrl+S, which flow control used to swallow", async () => {
    // Ctrl+S is XOFF on a cooked terminal. Raw mode clears IXON, so it has been an inert key at this
    // prompt all along — this is the test that it now arrives and does something.
    const p = await boot();
    const mark = p.output().length;
    p.write(CTRL_S);
    const seen = await p.waitFor(/API key|settings|Settings/, { timeoutMs: 15_000, since: mark });
    expect(seen.length).toBeGreaterThan(mark);
    p.write(ESCAPE);
    p.kill();
  }, 60_000);

  it("leaves a bare letter alone, because this prompt is where free text is typed", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("wander through the auth code");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const frame = p.output().slice(mark);
    // The letters landed on the line; no command ran.
    expect(frame).toContain("wander through the auth code");
    p.kill();
  }, 60_000);

  it("still opens the palette on Ctrl+G, and searches it by description", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write(CTRL_G);
    await p.waitFor(/❯|>/, { timeoutMs: 15_000, since: mark });
    const typed = p.output().length;
    // "revert" is nobody's command name — it is /undo's description, which is the whole point of
    // having a palette rather than only Tab completion.
    p.write("revert");
    const seen = await p.waitFor(/undo/, { timeoutMs: 15_000, since: typed });
    expect(seen.slice(typed)).toContain("undo");
    p.write(ESCAPE);
    p.kill();
  }, 60_000);

  it("finds a command from letters that are not adjacent", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write(CTRL_G);
    await p.waitFor(/❯|>/, { timeoutMs: 15_000, since: mark });
    const typed = p.output().length;
    p.write("wndr");
    const seen = await p.waitFor(/wander/, { timeoutMs: 15_000, since: typed });
    expect(seen.slice(typed)).toContain("wander");
    p.write(ESCAPE);
    p.kill();
  }, 60_000);
});
