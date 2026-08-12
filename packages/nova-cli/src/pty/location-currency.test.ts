import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTING_FIELDS } from "../settings";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnNova } from "./harness";

/**
 * Choosing where you are, and reading costs in your own money.
 *
 * The setting is only half of this. `resolveCurrencyPreference` runs once at startup, so a location
 * saved mid-session is easy to write correctly and still leave invisible until the next launch —
 * which to the person who just set it is indistinguishable from the setting not working. These
 * tests watch the numbers, not the file.
 */

const ENTER = "\r";
/** Menu rows are numbered by position in SETTING_FIELDS; deriving it survives new settings. */
const position = (key: string) => String(SETTING_FIELDS.findIndex((field) => field.key === key) + 1);

let stub: AnthropicStub; let cwd: string;
beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-loc-"));
});
afterAll(async () => { await stub.close(); });

async function boot(extraEnv: Record<string, string> = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-loccfg-"));
  const p = spawnNova({ cwd, args: [], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
    NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC",
    // A manual rate, so the conversion is exercised without reaching the network.
    NOVA_FX_RWF_PER_USD: "1300",
    ...extraEnv,
  }});
  await p.waitFor(/›/, { timeoutMs: 30_000 });
  return { p, configDir };
}

const ESCAPE = String.fromCharCode(27);

/**
 * Opens settings, picks one enumerated field's value from its list, and leaves.
 *
 * Driven the way a person does it now: jump to the row by its number, Enter to open the value list,
 * type enough to narrow it, Enter to take it, Escape to close the menu.
 */
async function setField(p: Awaited<ReturnType<typeof boot>>["p"], key: string, filter: string) {
  p.write(`/settings${ENTER}`);
  await p.waitFor(/Enter choose/, { timeoutMs: 15_000 });
  const mark = p.output().length;
  p.write(`${position(key)}${ENTER}`);
  await p.waitFor(/type to filter/, { timeoutMs: 15_000, since: mark });
  p.write(filter);
  const narrowed = p.output().length;
  p.write(ENTER);
  await p.waitFor(/Enter choose/, { timeoutMs: 15_000, since: narrowed });
  p.write(ESCAPE);
}

describe("choosing a location under a real pty", () => {
  it("changes the currency costs are shown in, without a restart", async () => {
    const { p } = await boot();
    const mark = p.output().length;
    await setField(p, "NOVA_COUNTRY", "rwanda");
    const seen = await p.waitFor(/costs now shown in RWF/, { timeoutMs: 20_000, since: mark });
    expect(seen.slice(mark)).toContain("location RW");
    p.kill();
  }, 90_000);

  it("persists it, so the next launch already reads in that currency", async () => {
    const { p, configDir } = await boot();
    await setField(p, "NOVA_COUNTRY", "rwanda");
    await p.waitFor(/costs now shown in RWF/, { timeoutMs: 20_000 });
    p.kill();

    expect(JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"))).toMatchObject({ NOVA_COUNTRY: "RW" });

    const second = spawnNova({ cwd, args: [], env: {
      ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url,
      NOVA_CONFIG_DIR: configDir, NOVA_FX_OFFLINE: "true", TZ: "UTC", NOVA_FX_RWF_PER_USD: "1300",
    }});
    const banner = await second.waitFor(/costs:/, { timeoutMs: 30_000 });
    expect(banner).toContain("RWF");
    expect(banner).toContain("location RW");
    second.kill();
  }, 90_000);

  it("reports the real cost of a turn in the chosen currency", async () => {
    // The number on screen is the point of the setting, so this asserts on a priced turn rather
    // than on the confirmation message.
    const { p } = await boot();
    await setField(p, "NOVA_COUNTRY", "rwanda");
    await p.waitFor(/costs now shown in RWF/, { timeoutMs: 20_000 });

    stub.enqueue({ kind: "text", text: "Hello there." });
    const mark = p.output().length;
    p.write(`say hi${ENTER}`);
    await p.waitFor(/Hello there/, { timeoutMs: 20_000, since: mark });

    const costMark = p.output().length;
    p.write(`/cost${ENTER}`);
    const report = await p.waitFor(/RWF/, { timeoutMs: 20_000, since: costMark });
    expect(report.slice(costMark)).toContain("RWF");
    p.kill();
  }, 120_000);

  it("offers only countries it can price in, so an unpriceable one cannot be entered", async () => {
    // This used to be a validation error you could earn by typing `ZZ`. Picking from a list makes
    // the invalid input unreachable instead of merely rejected, which is the better fix; the
    // validator still guards the typed path and is covered in settings.test.ts.
    const { p } = await boot();
    p.write(`/settings${ENTER}`);
    await p.waitFor(/Enter choose/, { timeoutMs: 15_000 });
    const mark = p.output().length;
    p.write(`${position("NOVA_COUNTRY")}${ENTER}`);
    await p.waitFor(/type to filter/, { timeoutMs: 15_000, since: mark });

    const searched = p.output().length;
    p.write("zz");
    const seen = await p.waitFor(/no match/, { timeoutMs: 15_000, since: searched });
    expect(seen.slice(searched)).toContain("no match");
    p.kill();
  }, 90_000);

  it("keeps costs where they are when no rate is available to convert with", async () => {
    // Switching to a currency nothing can be converted into would leave the session running and
    // reporting nothing; staying put and saying so is the honest outcome.
    const { p } = await boot({ NOVA_FX_RWF_PER_USD: "" });
    const mark = p.output().length;
    await setField(p, "NOVA_COUNTRY", "rwanda");
    const seen = await p.waitFor(/No USD→RWF rate is available/, { timeoutMs: 20_000, since: mark });
    expect(seen.slice(mark)).toContain("costs stay in USD");
    p.kill();
  }, 90_000);
});
