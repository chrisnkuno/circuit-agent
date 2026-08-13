import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnNova } from "./harness";

/**
 * Mnemonic shortcuts, against a real terminal.
 *
 * The binding table can be checked in a unit test, but the property that matters is not in the
 * table: it is that Alt+A reaches the process as a mode switch *and* that the letters it uses stay
 * ordinary text. A terminal is the only place both halves are true at once — node-pty sends the
 * real escape sequence, and readline decides what to do with it.
 */

const ALT = String.fromCharCode(27);

let stub: AnthropicStub; let cwd: string; let configDir: string;
beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-keys-"));
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-keyscfg-"));
});
afterAll(async () => { await stub.close(); });

function boot() {
  return spawnNova({ cwd, args: ["--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
    NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC",
  }});
}

describe("mnemonic keys under a real pty", () => {
  it("Alt+A switches to auto mode, while those same letters still type as text", async () => {
    const p = boot();
    await p.waitFor(/›/, { timeoutMs: 30_000 });

    const beforeKey = p.output().length;
    p.write(`${ALT}a`);
    await p.waitFor(/switched to auto mode/, { timeoutMs: 15_000, since: beforeKey });

    // The reason the letters are on Alt at all: a bare mnemonic would eat every message starting
    // with one of them, and "write a test" starts on an empty line just like a shortcut would.
    const beforeTyping = p.output().length;
    p.write("write a wander model auto");
    await p.waitFor(/write a wander model auto/, { timeoutMs: 15_000, since: beforeTyping });
    p.kill();
  }, 60_000);

  it("Alt+O runs /tools", async () => {
    const p = boot();
    await p.waitFor(/›/, { timeoutMs: 30_000 });
    const mark = p.output().length;
    p.write(`${ALT}o`);
    // The tools report is streamed line by line; wait for an actual tool row, not its heading.
    const seen = await p.waitFor(/read_file/, { timeoutMs: 15_000, since: mark });
    expect(seen.slice(mark)).toContain("read_file");
    p.kill();
  }, 60_000);
});
