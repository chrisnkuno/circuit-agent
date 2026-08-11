import { describe, expect, it } from "vitest";
import { buildModelCatalog, modelsForProvider, parseModelCommand, renderModelList } from "./models";

const paint = { dim: (text: string) => text, cyan: (text: string) => text, green: (text: string) => text, yellow: (text: string) => text };
const configured = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" };

describe("parsing the model command", () => {
  it("reads every form a user actually types", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "list" });
    expect(parseModelCommand("/models")).toEqual({ kind: "list" });
    expect(parseModelCommand("  /model  ")).toEqual({ kind: "list" });
    expect(parseModelCommand("/model 3")).toEqual({ kind: "pick", index: 3 });
    expect(parseModelCommand("/model anthropic claude-sonnet-5")).toEqual({ kind: "explicit", provider: "anthropic", model: "claude-sonnet-5" });
    expect(parseModelCommand("/model anthropic")).toEqual({ kind: "explicit", provider: "anthropic", model: undefined });
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

  it("never lists a model whose provider has no key", () => {
    // A menu whose entries fail on selection is worse than a shorter menu.
    const { choices, unconfigured } = buildModelCatalog({ ANTHROPIC_API_KEY: "k" });
    expect(choices.every((choice) => choice.provider === "anthropic")).toBe(true);
    expect(unconfigured.map((entry) => entry.provider).sort()).toEqual(["circuitnotion", "openai"]);
    expect(unconfigured.find((entry) => entry.provider === "openai")?.missing).toEqual(["OPENAI_API_KEY"]);
  });

  it("reports nothing to choose from when nothing is configured", () => {
    const catalog = buildModelCatalog({});
    expect(catalog.choices).toEqual([]);
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

describe("the numbered list", () => {
  const catalog = buildModelCatalog(configured, "2026-08-10");
  const rendered = renderModelList(catalog, {
    current: { provider: "anthropic", model: "claude-sonnet-5" },
    price: (choice) => (choice.prices ? "$2/$10 per Mtok" : "unpriced"),
    paint,
  });

  it("numbers every choice from one, contiguously, so /model N always resolves", () => {
    // The number is the entire interface; a gap or a repeat makes some entry unreachable.
    const numbers = [...rendered.matchAll(/^[^\d\n]*(\d+)\.\s/gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(catalog.choices.map((_, index) => index + 1));
  });

  it("indexes align with the catalog, which is what /model N looks up", () => {
    const command = parseModelCommand("/model 1");
    expect(command).toEqual({ kind: "pick", index: 1 });
    expect(catalog.choices[0].model).toBe("claude-sonnet-5");
  });

  it("marks the current model exactly once", () => {
    expect(rendered.match(/current/g) ?? []).toHaveLength(1);
    expect(rendered).toContain("claude-sonnet-5");
  });

  it("groups by provider and explains any it cannot offer", () => {
    const partial = buildModelCatalog({ ANTHROPIC_API_KEY: "k" });
    const text = renderModelList(partial, { current: { provider: "anthropic", model: "claude-sonnet-5" }, price: () => "", paint });
    expect(text).toContain("Anthropic");
    expect(text).toContain("set OPENAI_API_KEY");
    expect(text).toContain("nova settings");
  });

  it("tells the reader how to choose", () => {
    expect(rendered).toContain("/model <number>");
  });
});
