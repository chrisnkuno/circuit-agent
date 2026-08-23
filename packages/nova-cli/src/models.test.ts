import { describe, expect, it } from "vitest";
import { buildModelCatalog, describePrice, matchModelQuery, modelsForProvider, parseModelCommand } from "./models";

const paint = { dim: (text: string) => text, cyan: (text: string) => text, green: (text: string) => text, yellow: (text: string) => text };
const configured = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" };

describe("parsing the model command", () => {
  it("reads every form a user actually types", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "list" });
    expect(parseModelCommand("/models")).toEqual({ kind: "list" });
    expect(parseModelCommand("/models refresh")).toEqual({ kind: "refresh" });
    expect(parseModelCommand("  /model  ")).toEqual({ kind: "list" });
    expect(parseModelCommand("/model 3")).toEqual({ kind: "pick", index: 3 });
    expect(parseModelCommand("/model anthropic claude-sonnet-5")).toEqual({ kind: "explicit", provider: "anthropic", model: "claude-sonnet-5" });
    expect(parseModelCommand("/model anthropic")).toEqual({ kind: "explicit", provider: "anthropic", model: undefined });
  });

  it("reads a lone non-provider word as a name to search for, not a provider", () => {
    // The bug this closes: `/model opus` used to parse as provider "opus" and fail with
    // `Unknown provider "opus"` — an error about a word the user never meant as a provider.
    expect(parseModelCommand("/model opus")).toEqual({ kind: "query", text: "opus" });
    expect(parseModelCommand("/model claude-opus-5")).toEqual({ kind: "query", text: "claude-opus-5" });
  });

  it("keeps provider names reserved, so /model openai still means that provider's default", () => {
    expect(parseModelCommand("/model openai")).toEqual({ kind: "explicit", provider: "openai", model: undefined });
    expect(parseModelCommand("/model circuitnotion")).toEqual({ kind: "explicit", provider: "circuitnotion", model: undefined });
  });

  it("is not confused by commands that merely start the same way", () => {
    // `/mode` and `/model` share a prefix, and the old handler used startsWith.
    expect(parseModelCommand("/mode plan")).toBeNull();
    expect(parseModelCommand("/modelfoo")).toBeNull();
    expect(parseModelCommand("/todos")).toBeNull();
    expect(parseModelCommand("write a model class")).toBeNull();
  });
});

describe("the model catalog", () => {
  it("offers only text models, never embeddings or images", () => {
    // The catalog also prices text-embedding-3-large and gpt-image-1.5; offering either as
    // something to hold a conversation with is offering a mistake.
    const { choices } = buildModelCatalog(configured);
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.model).not.toMatch(/embedding|image|whisper|tts|audio/i);
    }
  });

  it("puts each provider's default first, since it is what doing nothing gives you", () => {
    const models = modelsForProvider("anthropic");
    expect(models[0]).toBe("claude-sonnet-5");
    expect(models).toContain("claude-opus-5");
    expect(new Set(models).size).toBe(models.length); // no duplicates
  });

  it("honours an environment model override as the default", () => {
    const { choices } = buildModelCatalog({ ...configured, ANTHROPIC_MODEL: "claude-opus-5" });
    const anthropic = choices.filter((choice) => choice.provider === "anthropic");
    expect(anthropic.find((choice) => choice.isProviderDefault)?.model).toBe("claude-opus-5");
    // Exactly one default per provider, or the list would mark two things as the same thing.
    expect(anthropic.filter((choice) => choice.isProviderDefault)).toHaveLength(1);
  });

  it("never lists a model whose provider has no key, except Ollama which needs none", () => {
    // A menu whose entries fail on selection is worse than a shorter menu.
    const { choices, unconfigured } = buildModelCatalog({ ANTHROPIC_API_KEY: "k" });
    expect(choices.every((choice) => choice.provider === "anthropic" || choice.provider === "ollama")).toBe(true);
    expect(unconfigured.map((entry) => entry.provider).sort()).toEqual(["circuitnotion", "openai"]);
    expect(unconfigured.find((entry) => entry.provider === "openai")?.missing).toEqual(["OPENAI_API_KEY"]);
  });

  it("still offers Ollama's local model when nothing else is configured", () => {
    const catalog = buildModelCatalog({});
    expect(catalog.choices.map((choice) => choice.provider)).toEqual(["ollama"]);
    expect(catalog.unconfigured).toHaveLength(3);
  });

  it("carries the catalog price, and admits when there is none", () => {
    const { choices } = buildModelCatalog(configured, "2026-08-10");
    const sonnet = choices.find((choice) => choice.model === "claude-sonnet-5")!;
    // The introductory rate, which is what "as of 2026-08-10" means.
    expect(sonnet.prices?.inputPerMillion).toBe(2_000_000);
    // A model the catalog has never priced still appears, marked unpriced rather than guessed at.
    expect(choices.some((choice) => choice.prices === undefined)).toBe(true);
  });
});

describe("matching a model by partial name", () => {
  const catalog = buildModelCatalog(configured, "2026-08-10");

  it("resolves a name that identifies exactly one model, inferring the provider", () => {
    const found = matchModelQuery(catalog, "claude-opus-4-7");
    expect(found).toMatchObject({ kind: "match", choice: { provider: "anthropic", model: "claude-opus-4-7" } });
  });

  it("prefers an exact id over the longer models it is a prefix of", () => {
    // Without tiering, the most precise thing a user can type is the one input guaranteed to be
    // ambiguous: `claude-opus-5` also prefixes claude-opus-5-* if such a model is ever catalogued.
    const catalogue = {
      choices: [
        { provider: "anthropic" as const, providerLabel: "Anthropic", model: "claude-opus-5", isProviderDefault: false, prices: undefined },
        { provider: "anthropic" as const, providerLabel: "Anthropic", model: "claude-opus-5-fast", isProviderDefault: false, prices: undefined },
      ],
      unconfigured: [],
    };
    expect(matchModelQuery(catalogue, "claude-opus-5")).toMatchObject({ kind: "match", choice: { model: "claude-opus-5" } });
  });

  it("is case-insensitive, because model ids are typed from memory", () => {
    expect(matchModelQuery(catalog, "CLAUDE-OPUS-4-7")).toMatchObject({ kind: "match" });
  });

  it("reports a tie instead of guessing, and names the candidates", () => {
    // Two models matching "opus" are two different bills; silently taking the first is a switch
    // the user never asked for and has no reason to notice.
    const found = matchModelQuery(catalog, "opus");
    expect(found.kind).toBe("ambiguous");
    if (found.kind !== "ambiguous") throw new Error("expected a tie");
    expect(found.candidates.length).toBeGreaterThan(1);
    expect(found.candidates.every((choice) => choice.model.includes("opus"))).toBe(true);
  });

  it("never matches a model whose provider has no key", () => {
    // A match that resolves to an unconfigured provider is a menu entry that fails on choosing.
    const anthropicOnly = buildModelCatalog({ ANTHROPIC_API_KEY: "k" }, "2026-08-10");
    expect(matchModelQuery(anthropicOnly, "gpt-5.6-terra")).toEqual({ kind: "none" });
  });

  it("reports no match for a name nothing has, rather than picking something close", () => {
    expect(matchModelQuery(catalog, "llama-3")).toEqual({ kind: "none" });
    expect(matchModelQuery(catalog, "   ")).toEqual({ kind: "none" });
  });
});

describe("pricing a model for display", () => {
  const prices = { currency: "RWF" as const, inputPerMillion: 1_610_000_000, outputPerMillion: 9_660_000_000 };

  it("falls back to the provider's own currency when no rate can convert it", () => {
    // The bug this closes: the fallback used `fromUnits`, which multiplies by a million — but these
    // are already micros. A 1,610 RWF rate rendered as "RWF 1,610,000,000", wrong by six orders of
    // magnitude, on the one path that only appears when an exchange rate is missing.
    const rendered = describePrice(prices, "USD", () => undefined);
    expect(rendered).toContain("1,610");
    expect(rendered).not.toContain("1,610,000,000");
    expect(rendered).toContain("per Mtok");
  });

  it("uses the converted amount when a rate is available", () => {
    const rendered = describePrice(prices, "USD", (value) => ({ currency: "USD", micros: value.micros / 1_320 }));
    expect(rendered).toContain("$");
  });

  it("says so plainly when there is no price at all", () => {
    expect(describePrice(undefined, "USD", () => undefined)).toBe("unpriced");
  });
});

/**
 * The numbered list this module used to render lives in `tables.ts` now, as columns — see
 * `buildModelTable`, which carries the number as a column so sorting cannot renumber the rows, and
 * `tables.test.ts`, which holds the invariants that came with it: contiguous numbering, the current
 * model marked once, and the unconfigured providers still explained.
 *
 * What stays here is the half that is this module's own: that the index `/model N` parses to is the
 * index into the catalog it looks up.
 */
describe("choosing by number", () => {
  it("indexes align with the catalog, which is what /model N looks up", () => {
    const catalog = buildModelCatalog(configured, "2026-08-10");
    expect(parseModelCommand("/model 1")).toEqual({ kind: "pick", index: 1 });
    expect(catalog.choices[0].model).toBe("claude-sonnet-5");
  });
});
