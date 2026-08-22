import { describe, expect, it } from "vitest";
import { isConversationalModel, mergeModelLists, modelsEndpoint, modelsUrl, parseModelsResponse } from "./model-list";

/**
 * The rules for asking a provider what it offers.
 *
 * Every failure this module exists to prevent looks like an outage from the outside: a doubled
 * `/v1` reads as a 404 from a provider that is down, a missing version header as a malformed
 * request, a missing key as an authentication problem with the key you do have. The tests are
 * written against those confusions rather than against the happy path.
 */

describe("where a model list lives", () => {
  it("never doubles a version segment a base URL already carries", () => {
    expect(modelsUrl("https://gateway.example/v1")).toBe("https://gateway.example/v1/models");
    expect(modelsUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1/models");
    expect(modelsUrl("https://api.example")).toBe("https://api.example/v1/models");
    expect(modelsUrl("https://api.example///")).toBe("https://api.example/v1/models");
  });

  it("presents each provider's key the way that provider actually wants it", () => {
    const anthropic = modelsEndpoint("anthropic", { ANTHROPIC_API_KEY: "sk-ant" });
    expect(anthropic?.headers["x-api-key"]).toBe("sk-ant");
    // Omitting the version header is a 400 that reads like a malformed request.
    expect(anthropic?.headers["anthropic-version"]).toBeTruthy();
    expect(anthropic?.url).toContain("/v1/models");

    expect(modelsEndpoint("openai", { OPENAI_API_KEY: "sk-oai" })?.headers.authorization).toBe("Bearer sk-oai");
    expect(modelsEndpoint("circuitnotion", { CIRCUITNOTION_API_KEY: "sk-cn" })?.headers.authorization).toBe("Bearer sk-cn");
  });

  it("says a provider cannot be asked rather than asking it without credentials", () => {
    // An unauthenticated request would come back 401, which reads as a bad key rather than none.
    expect(modelsEndpoint("anthropic", {})).toBeUndefined();
    expect(modelsEndpoint("openai", { OPENAI_API_KEY: "   " })).toBeUndefined();
    expect(modelsEndpoint("circuitnotion", {})).toBeUndefined();
  });

  it("honours a base-URL override, so a gateway or a relay is asked instead of the vendor", () => {
    const overridden = modelsEndpoint("openai", { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway.internal/v1" });
    expect(overridden?.url).toBe("https://gateway.internal/v1/models");
  });
});

describe("reading what came back", () => {
  it("accepts the shape every OpenAI-compatible gateway sends", () => {
    expect(parseModelsResponse({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.4" }] })).toEqual(["gpt-5.6-terra", "gpt-5.4"]);
  });

  it("returns nothing rather than guessing when the body is not a model list", () => {
    for (const body of [null, undefined, {}, { data: null }, { data: [{}] }, "not json", 42]) {
      expect(parseModelsResponse(body as never), JSON.stringify(body)).toEqual([]);
    }
  });

  it("keeps the known list when a live one is unavailable, and never loses a known model", () => {
    const known = ["claude-opus-5", "claude-sonnet-5"];
    expect(mergeModelLists(known, undefined)).toEqual(known);
    // A live list that omits a model Nova knows about must not make that model unselectable.
    const merged = mergeModelLists(known, ["claude-sonnet-5", "claude-haiku-4-5"]);
    for (const model of known) expect(merged).toContain(model);
    expect(merged).toContain("claude-haiku-4-5");
    expect(new Set(merged).size).toBe(merged.length);
  });

  it("filters out ids that cannot hold a conversation", () => {
    expect(isConversationalModel("claude-opus-5")).toBe(true);
    for (const id of ["text-embedding-3-large", "whisper-1", "dall-e-3", "tts-1"]) {
      expect(isConversationalModel(id), id).toBe(false);
    }
  });
});
