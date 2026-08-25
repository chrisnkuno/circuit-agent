import { describe, expect, it } from "vitest";
import { fallbackSetting, parseFallbackPreference } from "./fallback";

describe("provider fallback preference", () => {
  it("defaults to off and accepts ask mode", () => {
    expect(parseFallbackPreference(undefined)).toEqual({ kind: "off" });
    expect(parseFallbackPreference("ask")).toEqual({ kind: "ask" });
  });

  it("requires an explicit provider and model", () => {
    expect(parseFallbackPreference("openai:gpt-5.4-mini")).toEqual({ kind: "target", provider: "openai", model: "gpt-5.4-mini" });
    expect(parseFallbackPreference("anthropic/claude-sonnet-5")).toEqual({ kind: "target", provider: "anthropic", model: "claude-sonnet-5" });
    expect(parseFallbackPreference("gpt-5.4-mini")).toBeNull();
  });

  it("serializes only opt-in values", () => {
    expect(fallbackSetting({ kind: "off" })).toBeUndefined();
    expect(fallbackSetting({ kind: "target", provider: "ollama", model: "qwen3" })).toBe("ollama:qwen3");
  });
});
