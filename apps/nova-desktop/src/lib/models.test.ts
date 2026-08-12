import { describe, expect, it } from "vitest";
import { DESKTOP_PROVIDERS, buildModelOptions, filterModels, modelsForProvider } from "./models";

describe("the models the desktop app offers", () => {
  it("puts each provider's default first, since it is what you get by doing nothing", () => {
    expect(modelsForProvider("anthropic")[0]).toBe("claude-sonnet-5");
    expect(modelsForProvider("openai")[0]).toBe("gpt-5.6-terra");
    expect(modelsForProvider("circuitnotion")[0]).toBe("gpt-5.6-luna");
  });

  it("offers only text models, never embeddings or images", () => {
    // The catalog also prices text-embedding-3-large and gpt-image-1.5; offering either as
    // something to hold a conversation with is offering a mistake.
    const all = DESKTOP_PROVIDERS.flatMap((provider) => modelsForProvider(provider));
    expect(all.some((model) => model.includes("embedding"))).toBe(false);
    expect(all.some((model) => model.includes("image"))).toBe(false);
  });

  it("lists no model twice within a provider", () => {
    for (const provider of DESKTOP_PROVIDERS) {
      const models = modelsForProvider(provider);
      expect(new Set(models).size).toBe(models.length);
    }
  });

  it("prices what the catalog knows and says nothing where it does not", () => {
    const options = buildModelOptions("anthropic", "2026-08-10");
    const sonnet = options.find((option) => option.model === "claude-sonnet-5");
    expect(sonnet?.price).toContain("per Mtok");
    // A model with no published rate still appears — marked unpriced rather than guessed at.
    expect(options.every((option) => option.price === undefined || option.price.includes("per Mtok"))).toBe(true);
  });

  it("keeps every provider reachable, including ones with no key yet", () => {
    // The desktop app holds one provider's credentials at a time, and switching provider is a
    // legitimate thing to do from this menu. Hiding the others would make the app look
    // single-provider.
    const providers = new Set(buildModelOptions("anthropic").map((option) => option.provider));
    expect([...providers].sort()).toEqual(["anthropic", "circuitnotion", "openai"]);
  });

  it("marks exactly one default per provider", () => {
    const options = buildModelOptions("anthropic");
    for (const provider of DESKTOP_PROVIDERS) {
      expect(options.filter((option) => option.provider === provider && option.isDefault)).toHaveLength(1);
    }
  });
});

describe("filtering the model list", () => {
  const options = buildModelOptions("anthropic", "2026-08-10");

  it("ranks a prefix match above a mid-string one", () => {
    // Same rule as the CLI's picker: the row under the cursor should be the one being typed toward.
    const ranked = filterModels(options, "claude-opus");
    expect(ranked[0].model.startsWith("claude-opus")).toBe(true);
  });

  it("matches on part of a model id", () => {
    expect(filterModels(options, "haiku").every((option) => option.model.includes("haiku"))).toBe(true);
    expect(filterModels(options, "haiku").length).toBeGreaterThan(0);
  });

  it("finds a provider's models by the provider's name", () => {
    const byProvider = filterModels(options, "openai");
    expect(byProvider.length).toBeGreaterThan(0);
    expect(byProvider.every((option) => option.provider === "openai")).toBe(true);
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(filterModels(options, "")).toHaveLength(options.length);
    expect(filterModels(options, "   ")).toHaveLength(options.length);
    expect(filterModels(options, "llama-3")).toEqual([]);
  });

  it("is case-insensitive, since ids are typed from memory", () => {
    expect(filterModels(options, "HAIKU")).toEqual(filterModels(options, "haiku"));
  });
});
