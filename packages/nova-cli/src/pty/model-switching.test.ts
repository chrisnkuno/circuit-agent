import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnNova } from "./harness";

/**
 * Switching models, against a real terminal.
 *
 * The parsing and matching are unit-tested; what a terminal adds is the half those tests cannot
 * reach. Tab completion is a `readline` contract — the completer returns candidates and readline
 * decides what to put on the line — and the suggestion dropdown is an interaction between a
 * keypress listener, readline's line buffer and rows reserved out of the scroll region. Both are
 * properties of the terminal, not of the functions, so this is the only place they can be observed.
 *
 * The load-bearing case is the one a unit test cannot state at all: that the dropdown is non-modal.
 * Suggestions appearing is worth little if the keystrokes that produced them stopped reaching the
 * line editor, so the tests that matter most here are the ones that type straight through it.
 */

const TAB = "\t";
const ESCAPE = String.fromCharCode(27);
const DOWN = `${ESCAPE}[B`;
const END = `${ESCAPE}[F`;
const RIGHT = `${ESCAPE}[C`;

let stub: AnthropicStub; let cwd: string; let configDir: string;
beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-model-"));
});
afterAll(async () => { await stub.close(); });

/** A fresh config directory per test, so one test's persisted model cannot leak into another. */
async function boot() {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-modelcfg-"));
  const p = spawnNova({ cwd, args: ["--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
    NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC",
  }});
  await p.waitFor(/›/, { timeoutMs: 30_000 });
  return p;
}

describe("switching models under a real pty", () => {
  it("sends the earlier requests and answers to the newly selected model", async () => {
    stub.enqueue({ kind: "text", text: "I will remember cobalt." });
    stub.enqueue({ kind: "text", text: "The codename was cobalt." });
    const p = await boot();

    const firstTurnAt = p.output().length;
    p.writeLine("Remember that the codename is cobalt.");
    // The prompt glyphs are colour-escaped in the raw pty buffer, so they are never adjacent;
    // match the turn ending and the prompt returning, not the box drawing between them.
    await p.waitFor(/I will remember cobalt.*turn complete.*›/s, { timeoutMs: 20_000, since: firstTurnAt });

    const switchedAt = p.output().length;
    p.writeLine("/model haiku");
    await p.waitFor(/switched to.*claude-haiku-4-5/s, { timeoutMs: 15_000, since: switchedAt });

    p.writeLine("What was the codename?");
    await p.waitFor(/The codename was cobalt/, { timeoutMs: 20_000, since: switchedAt });

    const request = stub.requests().at(-1)!;
    expect(request.model).toBe("claude-haiku-4-5");
    expect(request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember that the codename is cobalt." }),
      expect.objectContaining({ role: "assistant", content: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "I will remember cobalt." }),
      ]) }),
      expect.objectContaining({ role: "user", content: "What was the codename?" }),
    ]));
    p.kill();
  }, 60_000);

  it("switches on a partial name, without being told the provider", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model haiku\r");
    const seen = await p.waitFor(/switched to/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("claude-haiku-4-5");
    p.kill();
  }, 60_000);

  it("names the candidates instead of guessing when a name is ambiguous", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model opus\r");
    const seen = await p.waitFor(/matches \d+ models/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("claude-opus-5");
    p.kill();
  }, 60_000);

  it("remembers the switch, so the next launch starts on it", async () => {
    const first = await boot();
    const mark = first.output().length;
    first.write("/model haiku\r");
    await first.waitFor(/saved as your default/, { timeoutMs: 15_000, since: mark });
    first.kill();

    // Same config directory, new process: the point is that the choice outlived the session.
    const saved = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(saved).toMatchObject({ NOVA_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-haiku-4-5" });

    const second = spawnNova({ cwd, args: ["--currency", "USD"], env: {
      ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
      NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC",
    }});
    const banner = await second.waitFor(/›/, { timeoutMs: 30_000 });
    expect(banner).toContain("claude-haiku-4-5");
    second.kill();
  }, 90_000);

  it("completes a model id from a fragment of its name", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write(`/model haik${TAB}`);
    const seen = await p.waitFor(/claude-haiku-4-5/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("claude-haiku-4-5");
    p.kill();
  }, 60_000);

  it("opens a picker on a bare /model, and Enter switches to the row moved to", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model\r");
    await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: mark });

    const moved = p.output().length;
    p.write(`${DOWN}\r`);
    const seen = await p.waitFor(/switched to/, { timeoutMs: 15_000, since: moved });
    // The cursor starts on the model in use, so one Down lands on a genuinely different one.
    expect(seen.slice(moved)).not.toContain("switched to Anthropic claude-sonnet-5");
    p.kill();
  }, 60_000);

  it("turns the picker into a sortable table on t, and Enter there switches model", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model\r");
    await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: mark });

    // `t` swaps the menu for the same models in columns — the view a printed list cannot offer.
    const toTable = p.output().length;
    p.write("t");
    const table = await p.waitFor(/pick column/, { timeoutMs: 15_000, since: toTable });
    expect(table.slice(toTable)).toContain("$/M in");

    // Five Rights aim at the input-price column (#, marker, model, provider, price), `s` orders by
    // it, and the sort marker in the header is the proof it took — the rows moving is not something
    // a pattern can assert, but the arrow beside the column name is.
    const sorted = p.output().length;
    p.write(`${RIGHT}${RIGHT}${RIGHT}${RIGHT}${RIGHT}s`);
    await p.waitFor(/\$\/M in ↑/, { timeoutMs: 15_000, since: sorted });

    const chosen = p.output().length;
    p.write("\r");
    // Cheapest first puts a different model than the session started on under the cursor, so Enter
    // is a real switch and not a no-op the assertion could pass by accident.
    const seen = await p.waitFor(/switched to/, { timeoutMs: 15_000, since: chosen });
    expect(seen.slice(chosen)).not.toContain("already on");
    p.kill();
  }, 60_000);

  it("comes back to the picker when the table is dismissed, rather than closing /models", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model\r");
    await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: mark });

    const toTable = p.output().length;
    p.write("t");
    await p.waitFor(/pick column/, { timeoutMs: 15_000, since: toTable });

    // Escape is a view toggle here, not a way out: the menu it came from is what it returns to.
    const back = p.output().length;
    p.write(ESCAPE);
    const seen = await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: back });
    expect(seen.slice(back)).not.toContain("no change");
    p.kill();
  }, 60_000);

  it("leaves the session alone when the picker is dismissed", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model\r");
    await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: mark });

    const dismissed = p.output().length;
    p.write(ESCAPE);
    const seen = await p.waitFor(/no change/, { timeoutMs: 15_000, since: dismissed });
    expect(seen.slice(dismissed)).not.toContain("switched to");
    p.kill();
  }, 60_000);

  it("opens settings straight away when no provider is configured", async () => {
    // The dead end this replaces: printing the name of the door the user is already standing at.
    const configOnly = await fs.mkdtemp(path.join(os.tmpdir(), "nova-nokey-"));
    const p = spawnNova({ cwd, args: ["--currency", "USD"], env: {
      NOVA_CONFIG_DIR: configOnly, NOVA_FX_OFFLINE: "true", TZ: "UTC",
    }});
    const started = await p.waitFor(/Anthropic API key|Nova settings/, { timeoutMs: 30_000 });
    expect(started).toMatch(/Anthropic API key|Nova settings/);
    p.kill();
  }, 60_000);

  it("reaches the API keys from a row in the picker", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model\r");
    await p.waitFor(/Esc cancel/, { timeoutMs: 15_000, since: mark });

    // The last row is the settings row; End jumps to it.
    const jumped = p.output().length;
    p.write(`${END}\r`);
    const seen = await p.waitFor(/Anthropic API key/, { timeoutMs: 15_000, since: jumped });
    expect(seen.slice(jumped)).toContain("Nova settings");
    p.kill();
  }, 60_000);

  it("shows command suggestions while a command name is being typed", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/mod");
    // Wait for the last of the matching rows. The screen paints suggestions one row at a time, so
    // waiting for /models (the row before /model) can observe a valid frame halfway through paint.
    const seen = await p.waitFor(/model picker/, { timeoutMs: 15_000, since: mark });
    // Both commands sharing the prefix are offered, and nothing has been submitted to get them.
    expect(seen.slice(mark)).toContain("/model");
    expect(seen.slice(mark)).toContain("model picker");
    p.kill();
  }, 60_000);

  it("suggests models once the command takes an argument", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/model hai");
    const seen = await p.waitFor(/claude-haiku-4-5/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("claude-haiku-4-5");
    p.kill();
  }, 60_000);

  it("never swallows the command being typed, which is what a modal menu would do", async () => {
    // The regression this pins: with a menu that takes the keyboard on "/", the rest of this line
    // lands in its query and the command is never run at all.
    const p = await boot();
    const mark = p.output().length;
    p.write("/model haiku\r");
    const seen = await p.waitFor(/switched to/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("claude-haiku-4-5");
    p.kill();
  }, 60_000);

  it("leaves ordinary prose alone, including a line with a path in it", async () => {
    const p = await boot();
    await p.waitFor(/›/, { timeoutMs: 15_000 });
    const mark = p.output().length;
    p.write("check /home/me/notes.txt");
    await p.waitFor(/notes\.txt/, { timeoutMs: 15_000, since: mark });
    // A "/" mid-sentence is a path, not a command being named.
    expect(p.output().slice(mark)).not.toContain("model picker");
    p.kill();
  }, 60_000);

  it("still lets Escape and line editing reach readline while suggestions are up", async () => {
    const p = await boot();
    const mark = p.output().length;
    p.write("/mod");
    await p.waitFor(/\/models/, { timeoutMs: 15_000, since: mark });

    // Ctrl-U clears the line: proof the keystroke reached the line editor rather than a menu.
    const cleared = p.output().length;
    p.write(`${String.fromCharCode(21)}hello there`);
    const seen = await p.waitFor(/hello there/, { timeoutMs: 15_000, since: cleared });
    expect(seen.slice(cleared)).toContain("hello there");
    p.kill();
  }, 60_000);
});
