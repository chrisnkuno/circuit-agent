import { describe, expect, it } from "vitest";
import { PROVIDER_IDS, PROVIDER_INFO, catalogPrices, isProviderId } from "./provider-specs";

/**
 * Provider identity, which is data — and which everything else keys off.
 *
 * This module exists to be importable without pulling a vendor SDK behind it, so the tests here
 * deliberately touch only the data half. If a provider is ever added, these are the invariants that
 * decide whether the rest of the system can see it at all.
 */

describe("who Nova can talk to", () => {
  it("describes every provider it lists, and lists every provider it describes", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDER_INFO).sort());
    for (const id of PROVIDER_IDS) {
      const info = PROVIDER_INFO[id];
      expect(info.id, id).toBe(id);
      expect(info.label.trim().length, id).toBeGreaterThan(0);
      expect(info.defaultModel.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("recognises exactly the ids it ships, and nothing that merely looks like one", () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id), id).toBe(true);
    for (const wrong of ["", "Anthropic", "openai ", "gpt", "azure", null, undefined, 7]) {
      expect(isProviderId(wrong as never), String(wrong)).toBe(false);
    }
  });

  it("names required credentials for hosted providers and none for the local one", () => {
    for (const id of PROVIDER_IDS) {
      const required = PROVIDER_INFO[id].requires;
      // Ollama needs nothing — it is a daemon on this machine, and pretending otherwise would make
      // it un-selectable for the one user who has it running.
      if (id === "ollama") expect(required, id).toEqual([]);
      else expect(required.length, id).toBeGreaterThan(0);
    }
  });

  it("prices a model it knows and says nothing about one it does not", () => {
    const known = catalogPrices("anthropic", PROVIDER_INFO.anthropic.defaultModel);
    if (known) {
      expect(known.inputPerMillion).toBeGreaterThan(0);
      expect(known.outputPerMillion).toBeGreaterThan(0);
      expect(known.currency.trim().length).toBeGreaterThan(0);
    }
    // An unpriced model must return nothing rather than a zero, which would read as "free".
    expect(catalogPrices("anthropic", "claude-model-that-does-not-exist")).toBeUndefined();
  });
});
