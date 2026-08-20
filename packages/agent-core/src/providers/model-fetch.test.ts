import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CACHE_TTL_MS,
  fetchProviderModels,
  fetchableProviders,
  isCacheFresh,
  isConversationalModel,
  loadLiveModels,
  mergeModelLists,
  modelCacheFile,
  modelsEndpoint,
  modelsUrl,
  parseModelsResponse,
  readModelCache,
  writeModelCache,
  type FetchLike,
} from "./model-fetch";
import { PROVIDER_IDS } from "./agent-matrix";

let home: string;
let environment: Record<string, string | undefined>;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nova-models-"));
  environment = { NOVA_CONFIG_DIR: home, HOME: home, XDG_CONFIG_HOME: home };
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const ok = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

describe("where a provider's list lives", () => {
  it("authenticates each provider the way that provider expects", () => {
    const anthropic = modelsEndpoint("anthropic", { ...environment, ANTHROPIC_API_KEY: "k" })!;
    expect(anthropic.url).toContain("api.anthropic.com/v1/models");
    // Anthropic wants x-api-key *and* a version; omitting the version is a 400 that reads like a
    // malformed request rather than a missing header.
    expect(anthropic.headers["x-api-key"]).toBe("k");
    expect(anthropic.headers["anthropic-version"]).toBeTruthy();

    const openai = modelsEndpoint("openai", { ...environment, OPENAI_API_KEY: "k" })!;
    expect(openai.headers.authorization).toBe("Bearer k");
  });

  it("asks Ollama, which has no key to present", () => {
    // Left out of the switch, Ollama was not merely unasked: `PROVIDERS.ollama.requires` is empty,
    // so it counts as configured and was asked on every refresh — then answered "no key
    // configured" about a provider that has never had a key. Meanwhile the models that most need
    // asking about, because no catalog will ever list a local `llama3.3:70b-instruct-q5_K_M`,
    // were the ones nobody could see.
    const ollama = modelsEndpoint("ollama", environment)!;
    expect(ollama.url).toBe("http://localhost:11434/v1/models");
    expect(ollama.headers).toEqual({});
    expect(modelsEndpoint("ollama", { ...environment, OLLAMA_BASE_URL: "http://nas.local:11434/v1" })!.url)
      .toBe("http://nas.local:11434/v1/models");
  });

  it("has an endpoint for every provider Nova can be configured to use", () => {
    // The failure this replaces was silent: a provider with no case here reports "no key
    // configured" forever, which reads like the user's mistake rather than a missing branch.
    const withKeys = {
      ...environment,
      ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CIRCUITNOTION_API_KEY: "k",
    };
    for (const provider of PROVIDER_IDS) {
      expect(modelsEndpoint(provider, withKeys), `no models endpoint for ${provider}`).toBeDefined();
    }
  });

  it("honours a custom base url, which is how proxies and gateways are reached", () => {
    expect(modelsEndpoint("openai", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway.internal" })!.url)
      .toBe("https://gateway.internal/v1/models");
  });

  it("does not double the version segment on a base url that already carries it", () => {
    // The official SDKs take a base *including* /v1, so that is how gateways get configured.
    // Appending blindly gives /v1/v1/models, which 404s and reads like the provider being down.
    for (const base of ["https://gateway.internal/v1", "https://gateway.internal/v1/"]) {
      expect(modelsEndpoint("openai", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: base })!.url)
        .toBe("https://gateway.internal/v1/models");
    }
    expect(modelsUrl("https://x.dev/")).toBe("https://x.dev/v1/models");
  });

  it("returns nothing without a key rather than a request that will 401", () => {
    expect(modelsEndpoint("anthropic", {})).toBeUndefined();
    expect(modelsEndpoint("openai", { OPENAI_API_KEY: "   " })).toBeUndefined();
  });
});

describe("reading a models response", () => {
  it("takes the documented shape", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("takes the shapes proxies actually return, rather than failing on them", () => {
    expect(parseModelsResponse(["a", "b"])).toEqual(["a", "b"]);
    expect(parseModelsResponse({ models: [{ name: "a" }] })).toEqual(["a"]);
  });

  it("drops entries it cannot name, and keeps the rest", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, {}, 7, null, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("returns nothing for a body that is not a list at all", () => {
    expect(parseModelsResponse({ error: "nope" })).toEqual([]);
    expect(parseModelsResponse(null)).toEqual([]);
  });

  it("does not repeat an id listed twice", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "a" }] })).toEqual(["a"]);
  });
});

describe("which models can hold a conversation", () => {
  it("keeps chat models", () => {
    for (const model of ["claude-sonnet-5", "gpt-5.6-terra", "o4-mini", "llama-3.3-70b", "qwen3-coder"]) {
      expect(isConversationalModel(model), model).toBe(true);
    }
  });

  it("drops the ones that would fail one turn later", () => {
    // Offering an embedding model in a menu of things to talk to is offering a mistake.
    for (const model of [
      "text-embedding-3-large", "omni-moderation-latest", "whisper-1", "tts-1-hd",
      "dall-e-3", "gpt-4o-realtime-preview", "rerank-english-v3", "llama-guard-3",
    ]) {
      expect(isConversationalModel(model), model).toBe(false);
    }
  });
});

describe("asking a provider", () => {
  it("returns what it was told, sorted", async () => {
    const result = await fetchProviderModels("openai", { ...environment, OPENAI_API_KEY: "k" },
      ok({ data: [{ id: "gpt-b" }, { id: "gpt-a" }] }));
    expect(result).toEqual({ provider: "openai", models: ["gpt-a", "gpt-b"] });
  });

  it("filters the non-chat models out of a real-looking list", async () => {
    const result = await fetchProviderModels("openai", { ...environment, OPENAI_API_KEY: "k" },
      ok({ data: [{ id: "gpt-5.6" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }] }));
    expect(result.models).toEqual(["gpt-5.6"]);
  });

  it("reports a refusal instead of throwing, so /models still lists what it knows", async () => {
    const result = await fetchProviderModels("openai", { ...environment, OPENAI_API_KEY: "k" },
      async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(result).toMatchObject({ models: [], error: "provider returned 401" });
  });

  it("reports a network failure the same way", async () => {
    const result = await fetchProviderModels("openai", { ...environment, OPENAI_API_KEY: "k" },
      async () => { throw new Error("ENOTFOUND"); });
    expect(result.error).toContain("ENOTFOUND");
  });

  it("gives up rather than holding the prompt open forever", async () => {
    vi.useFakeTimers();
    const hang: FetchLike = () => new Promise(() => {});
    const pending = fetchProviderModels("openai", { ...environment, OPENAI_API_KEY: "k" }, hang, 50);
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toMatchObject({ error: "timed out" });
    vi.useRealTimers();
  });

  it("says so without a request when there is no key", async () => {
    const called = vi.fn();
    const result = await fetchProviderModels("anthropic", environment, called as unknown as FetchLike);
    expect(result.error).toBe("no key configured");
    expect(called).not.toHaveBeenCalled();
  });
});

describe("the cache", () => {
  it("round-trips through a file the user could read", async () => {
    await writeModelCache(environment, { fetchedAt: 5, models: { openai: ["a"] } });
    expect(await readModelCache(environment)).toEqual({ fetchedAt: 5, models: { openai: ["a"] } });
    expect(modelCacheFile(environment)).toContain("models.json");
  });

  it("treats a missing or unreadable cache as no cache", async () => {
    expect(await readModelCache(environment)).toBeUndefined();
    await fs.mkdir(path.dirname(modelCacheFile(environment)), { recursive: true });
    await fs.writeFile(modelCacheFile(environment), "not json");
    expect(await readModelCache(environment)).toBeUndefined();
  });

  it("is fresh inside the window and stale outside it", () => {
    const now = 1_000_000;
    expect(isCacheFresh({ fetchedAt: now - 1_000, models: {} }, now)).toBe(true);
    expect(isCacheFresh({ fetchedAt: now - MODEL_CACHE_TTL_MS - 1, models: {} }, now)).toBe(false);
    expect(isCacheFresh(undefined, now)).toBe(false);
  });

  it("treats a cache stamped in the future as stale, since that is a moved clock", () => {
    const now = 1_000_000;
    expect(isCacheFresh({ fetchedAt: now + 60_000, models: {} }, now)).toBe(false);
  });
});

describe("loading every provider's list", () => {
  it("uses a fresh cache without touching the network", async () => {
    await writeModelCache(environment, { fetchedAt: 1_000, models: { openai: ["cached"] } });
    const called = vi.fn();
    const loaded = await loadLiveModels(["openai"], environment, { fetchImpl: called as unknown as FetchLike, now: 2_000 });
    expect(loaded).toMatchObject({ models: { openai: ["cached"] }, fromCache: true });
    expect(called).not.toHaveBeenCalled();
  });

  it("refetches when asked, even with a fresh cache", async () => {
    await writeModelCache(environment, { fetchedAt: 1_000, models: { openai: ["cached"] } });
    const loaded = await loadLiveModels(["openai"], { ...environment, OPENAI_API_KEY: "k" },
      { fetchImpl: ok({ data: [{ id: "live" }] }), now: 2_000, refresh: true });
    expect(loaded).toMatchObject({ models: { openai: ["live"] }, fromCache: false });
  });

  it("writes what it fetched, so the next session is free", async () => {
    await loadLiveModels(["openai"], { ...environment, OPENAI_API_KEY: "k" },
      { fetchImpl: ok({ data: [{ id: "live" }] }), now: 9_000 });
    expect(await readModelCache(environment)).toEqual({ fetchedAt: 9_000, models: { openai: ["live"] } });
  });

  it("keeps the providers that answered when another fails", async () => {
    const fetchImpl: FetchLike = async (url) => url.includes("anthropic")
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-x" }] }) };
    const loaded = await loadLiveModels(["anthropic", "openai"],
      { ...environment, ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }, { fetchImpl, now: 1 });
    expect(loaded.models).toEqual({ openai: ["gpt-x"] });
    expect(loaded.errors.map((error) => error.provider)).toEqual(["anthropic"]);
  });

  it("caches nothing when nothing came back, so a failure is retried rather than remembered", async () => {
    await loadLiveModels(["openai"], { ...environment, OPENAI_API_KEY: "k" },
      { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), now: 1 });
    expect(await readModelCache(environment)).toBeUndefined();
  });
});

describe("merging with what this build knew", () => {
  it("keeps the known order and appends the new, sorted", () => {
    // The known order was chosen — provider default first — and a live list is alphabetical noise
    // by comparison, so it must not be allowed to reshuffle a list people have learned.
    expect(mergeModelLists(["default", "beta"], ["zeta", "alpha", "beta"]))
      .toEqual(["default", "beta", "alpha", "zeta"]);
  });

  it("changes nothing when there is nothing live", () => {
    expect(mergeModelLists(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(mergeModelLists(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("never repeats a model that both sources list", () => {
    const merged = mergeModelLists(["a"], ["a"]);
    expect(merged).toEqual(["a"]);
  });
});

describe("which providers are worth asking", () => {
  it("skips the ones with no key, since the answer is already known", () => {
    expect(fetchableProviders({ OPENAI_API_KEY: "k" }, ["anthropic", "openai"])).toEqual(["openai"]);
    expect(fetchableProviders({}, ["anthropic", "openai"])).toEqual([]);
  });
});
