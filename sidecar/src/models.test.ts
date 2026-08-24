import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, STUB_MODELS, type AnthropicStub } from "../test/anthropic-stub.js";
import { NovaHost } from "./host.js";
import { settingsToCatalogEnvironment } from "./settings.js";
import type { IpcEvent, ModelsListResult, NovaSettings } from "./protocol.js";

/**
 * Asking the providers what models the pasted key can actually reach.
 *
 * The desktop's menu was built from the price catalog, which lists a model only once someone has
 * written down what it costs. Providers ship faster than any rate table is updated, so the models
 * missing from that list are exactly the new ones people are looking for. These tests pin the two
 * properties that make the fix trustworthy rather than merely longer: the list is the provider's
 * own answer, and a key is only ever presented to the provider it belongs to.
 */

let stub: AnthropicStub;
let configDir: string;

beforeAll(async () => {
  stub = await startAnthropicStub();
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-models-config-"));
  // The model cache is shared with the CLI and lives in the Nova config directory. Pointed at a
  // temporary one so a developer's real cache neither answers these tests nor is overwritten.
  process.env.NOVA_CONFIG_DIR = configDir;
});

afterAll(async () => {
  await stub.close();
  await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.NOVA_CONFIG_DIR;
});

beforeEach(async () => {
  // Every test asks fresh: a six-hour cache is right for a running app and wrong for a suite,
  // where it would let one test's answer decide the next test's assertion.
  await fs.rm(path.join(configDir, "models.json"), { force: true });
});

const settings = (): NovaSettings => ({
  provider: "anthropic",
  apiKey: "sk-ant-test",
  baseUrl: stub.url,
  model: "claude-sonnet-5",
  currency: "USD",
});

function bootHost() {
  const events: IpcEvent[] = [];
  const host = new NovaHost((event) => events.push(event));
  const request = async (payload: Record<string, unknown>) =>
    host.handle({ id: `req_${events.length}`, ...payload } as never);
  return { host, request };
}

describe("the models a pasted key can reach", () => {
  it("caches into the config directory the tests were pointed at, not the developer's own", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    await request({ type: "models.list", refresh: true });

    // The evidence that isolation is real rather than assumed. Before the config directory was
    // carried through, this file was written to the machine's actual `~/.config/nova`, where a
    // stub model id would then be offered by every real session for the next six hours.
    const cache = JSON.parse(await fs.readFile(path.join(configDir, "models.json"), "utf8"));
    expect(cache.models.anthropic).toContain("claude-vega-6-20270114");
  });

  it("lists what the provider says it has, not only what this build has a price for", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const result = await request({ type: "models.list", refresh: true }) as ModelsListResult;

    const anthropic = result.providers.find((entry) => entry.provider === "anthropic");
    expect(anthropic?.error).toBeUndefined();
    // The id no catalog knows is the whole point: without the fetch it cannot appear at all, so
    // its presence is the only proof the list came from the provider rather than from the build.
    expect(anthropic?.models).toContain("claude-vega-6-20270114");
    expect(anthropic?.models).toContain("claude-opus-5");
  });

  it("drops what cannot hold a conversation, so the menu has no traps in it", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const result = await request({ type: "models.list", refresh: true }) as ModelsListResult;

    // `/v1/models` lists embeddings alongside chat models. Offering one as something to talk to is
    // offering a mistake whose error arrives a turn later from three layers down.
    expect(STUB_MODELS).toContain("text-embedding-3-large");
    expect(result.providers.find((entry) => entry.provider === "anthropic")?.models)
      .not.toContain("text-embedding-3-large");
  });

  it("asks nothing at all when no key has been pasted yet", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: { ...settings(), apiKey: "" } })
      .catch(() => undefined); // an empty key is refused at the door; the list must still be safe
    const before = stub.modelListCount();
    const result = await request({ type: "models.list", refresh: true }) as ModelsListResult;

    expect(result.providers).toEqual([]);
    expect(stub.modelListCount()).toBe(before);
  });

  it("reports a provider that fails without losing the ones that answered", async () => {
    const { request } = bootHost();
    // A second provider whose base URL points nowhere. The failure has to stay on its own row:
    // one unreachable gateway must not empty the menu for the key that works.
    await request({
      type: "settings.set",
      settings: {
        ...settings(),
        credentials: {
          anthropic: { apiKey: "sk-ant-test", baseUrl: stub.url },
          openai: { apiKey: "sk-openai-test", baseUrl: "http://127.0.0.1:9/v1" },
        },
      },
    });
    const result = await request({ type: "models.list", refresh: true }) as ModelsListResult;

    expect(result.providers.find((entry) => entry.provider === "anthropic")?.models.length).toBeGreaterThan(0);
    const openai = result.providers.find((entry) => entry.provider === "openai");
    expect(openai?.models).toEqual([]);
    expect(openai?.error).toBeTruthy();
  });
});

describe("the environment the fetch runs against", () => {
  it("never presents one provider's key under another provider's name", () => {
    // The bug this shape exists to prevent, in its original form: the form held a single key, so
    // switching provider went on sending the previous provider's secret to the new one's URL.
    const env = settingsToCatalogEnvironment({
      provider: "anthropic",
      apiKey: "sk-ant-selected",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5",
      credentials: {
        openai: { apiKey: "sk-openai-stored", baseUrl: "https://api.openai.com/v1" },
      },
    });

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-selected");
    expect(env.OPENAI_API_KEY).toBe("sk-openai-stored");
    expect(env.CIRCUITNOTION_API_KEY).toBeUndefined();
    // No variable anywhere may carry a key that is not its own provider's.
    expect(Object.entries(env).filter(([name]) => name.endsWith("_API_KEY")))
      .toEqual([["ANTHROPIC_API_KEY", "sk-ant-selected"], ["OPENAI_API_KEY", "sk-openai-stored"]]);
  });

  it("names the config directory, so the fetched list lands in the cache the CLI reads", () => {
    // Built from settings alone this environment names no config directory, `novaConfigDirectory`
    // falls back to the home directory, and two things go wrong at once: the desktop keeps a
    // second cache the CLI never sees, and no test can point either at a temporary one — which is
    // how a suite ends up writing stub model ids into a developer's real `~/.config/nova`.
    const env = settingsToCatalogEnvironment(
      { provider: "anthropic", apiKey: "sk-ant", baseUrl: "", model: "claude-opus-5" },
      { NOVA_CONFIG_DIR: "/tmp/nova-config", XDG_CONFIG_HOME: "/tmp/xdg" },
    );
    expect(env.NOVA_CONFIG_DIR).toBe("/tmp/nova-config");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/xdg");
  });

  it("carries no process variable that is not about where config lives", () => {
    // The environment is built from settings so that one provider's key can never travel under
    // another's name. Copying the process environment wholesale to get the config path would undo
    // that in one line: an exported ANTHROPIC_API_KEY would silently outrank the stored one.
    const env = settingsToCatalogEnvironment(
      { provider: "anthropic", apiKey: "sk-from-settings", baseUrl: "", model: "claude-opus-5" },
      { NOVA_CONFIG_DIR: "/tmp/nova-config", ANTHROPIC_API_KEY: "sk-exported", OPENAI_API_KEY: "sk-exported-too" },
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-from-settings");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("includes every provider with a stored key, not just the selected one", () => {
    // The picker offers all three. A provider left out of the environment is one whose menu
    // silently stays at whatever this build was compiled knowing.
    const env = settingsToCatalogEnvironment({
      provider: "circuitnotion",
      apiKey: "sk-cn",
      baseUrl: "",
      model: "gpt-5.6-luna",
      credentials: {
        anthropic: { apiKey: "sk-ant" },
        openai: { apiKey: "sk-oai" },
      },
    });
    expect(Object.keys(env).filter((name) => name.endsWith("_API_KEY")).sort())
      .toEqual(["ANTHROPIC_API_KEY", "CIRCUITNOTION_API_KEY", "OPENAI_API_KEY"]);
  });
});
