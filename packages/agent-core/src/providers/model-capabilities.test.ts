import { describe, expect, it } from "vitest";
import { CONSERVATIVE_CAPABILITIES, DEFAULT_OUTPUT_CEILING, budgetsFor, capabilitiesFor } from "./model-capabilities";

describe("what a model can hold and produce", () => {
  it("gives the current models their real window instead of a 200K guess", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(1_000_000);
      expect(capabilitiesFor(id).maxOutputTokens, id).toBe(128_000);
    }
  });

  it("does not inflate a model that really is 200K", () => {
    expect(capabilitiesFor("claude-haiku-4-5")).toEqual({ contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false });
  });

  it("handles CircuitNotion's default alias explicitly without guessing unpublished limits", () => {
    const capabilities = capabilitiesFor("circuit-2-turbo");
    expect(capabilities).toEqual({ contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false });
    expect(capabilities).not.toBe(CONSERVATIVE_CAPABILITIES);
  });

  it("treats an unknown model exactly as Nova did before this table existed", () => {
    // The dangerous failure is optimism: assuming a big window for an id nobody recognises turns a
    // local decision into a provider 400 halfway through the work.
    for (const id of ["gpt-9-turbo", "llama-4", "", "   ", undefined]) {
      expect(capabilitiesFor(id), String(id)).toEqual(CONSERVATIVE_CAPABILITIES);
    }
  });

  it("sees through platform routing prefixes and version suffixes", () => {
    for (const id of [
      "anthropic.claude-opus-5",
      "us.anthropic.claude-opus-5",
      "my-gateway/claude-opus-5",
      "CLAUDE-OPUS-5",
      "claude-opus-5-20260101",
      "claude-opus-4-6@20260101",
    ]) {
      expect(capabilitiesFor(id).contextWindow, id).toBe(1_000_000);
    }
  });

  it("resolves by the longest matching family, never a shorter one", () => {
    // `claude-haiku-4-5` and `claude-opus-4-8` share no prefix, but a future short row must never
    // win over a specific one — this is the property that keeps the table extensible.
    expect(capabilitiesFor("claude-opus-4-8-preview").maxOutputTokens).toBe(128_000);
    expect(capabilitiesFor("claude-haiku-4-5-fast").contextWindow).toBe(200_000);
  });
});

describe("models matched exactly rather than by family", () => {
  it("gives the verified OpenAI flagships their real window", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"]) {
      expect(capabilitiesFor(id), id).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsEffort: true });
    }
  });

  it("does not hand a smaller sibling the flagship's limits on no evidence", () => {
    // `gpt-5.4-mini` is a different model whose published numbers nobody has verified here. A
    // prefix rule would have quietly given it a million-token window.
    for (const id of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.6", "gpt-5.6-sol-preview"]) {
      expect(capabilitiesFor(id), id).toEqual(CONSERVATIVE_CAPABILITIES);
    }
  });
});

describe("the budgets a session derives from its model", () => {
  it("uses the whole window for context and a bounded ceiling for output", () => {
    expect(budgetsFor("claude-opus-5")).toEqual({ contextLimit: 1_000_000, maxOutputTokens: DEFAULT_OUTPUT_CEILING });
  });

  it("never asks for more output than the model will produce", () => {
    // Haiku's 16K ceiling is below the default, so the default must not raise it.
    expect(budgetsFor("claude-haiku-4-5").maxOutputTokens).toBe(16_000);
    expect(budgetsFor("who-knows").maxOutputTokens).toBe(16_000);
  });

  it("keeps output well under the context it is reserved against", () => {
    for (const id of ["claude-opus-5", "claude-haiku-4-5", "unknown-model"]) {
      const { contextLimit, maxOutputTokens } = budgetsFor(id);
      expect(maxOutputTokens, id).toBeLessThan(contextLimit / 2);
    }
  });
});
