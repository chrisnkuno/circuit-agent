import { describe, expect, it } from "vitest";
import { CircuitNotionPresetsProvider } from "./circuitnotion-presets";

const context = { hasConnectedRepository: false, recentObjectives: [] };
const presets = [{ label: "Add a README", objective: "add a README.md that explains what's in the workspace" }];
const usage = { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 };

describe("CircuitNotionPresetsProvider", () => {
  it("uses Chat Completions with JSON mode and returns the parsed presets", async () => {
    let body: unknown;
    const provider = new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" }, async (value) => {
      body = value;
      return { id: "chatcmpl_1", model: "gpt-5.5-nano", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ presets }) } }], usage };
    });
    const result = await provider.generate(context);
    expect(body).toMatchObject({ model: "gpt-5.5-nano", response_format: { type: "json_object" } });
    expect(result).toEqual(presets);
    expect(JSON.stringify(body)).not.toContain("cn_test");
  });

  it("retries once on invalid JSON, then returns the retried result", async () => {
    let calls = 0;
    const provider = new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" }, async () => {
      calls += 1;
      if (calls === 1) return { id: "bad", model: "gpt-5.5-nano", choices: [{ finish_reason: "stop", message: { content: "not json" } }], usage };
      return { id: "good", model: "gpt-5.5-nano", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ presets }) } }], usage };
    });
    const result = await provider.generate(context);
    expect(calls).toBe(2);
    expect(result).toEqual(presets);
  });

  it("fails closed after a second invalid response instead of fabricating presets", async () => {
    const provider = new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" }, async () => ({
      id: "bad", model: "gpt-5.5-nano", choices: [{ finish_reason: "stop", message: { content: "still not json" } }], usage,
    }));
    await expect(provider.generate(context)).rejects.toThrow("after one retry");
  });

  it("surfaces an explicit refusal instead of fabricating presets", async () => {
    const provider = new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" }, async () => ({
      id: "refused", model: "gpt-5.5-nano", choices: [{ finish_reason: "stop", message: { content: null, refusal: "Cannot assist." } }], usage,
    }));
    await expect(provider.generate(context)).rejects.toThrow("Cannot assist.");
  });

  it("requires an API key and a model", () => {
    expect(() => new CircuitNotionPresetsProvider({ apiKey: "", model: "gpt-5.5-nano" })).toThrow("CIRCUITNOTION_API_KEY");
    expect(() => new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "" })).toThrow("CIRCUITNOTION_PRESETS_MODEL");
  });

  it("extracts a JSON object from surrounding commentary the model was told not to add", async () => {
    // The instruction is "JSON only, no commentary" — extractJson is what makes the call still
    // succeed the one time a model adds "Here you go:" in front of it anyway.
    const provider = new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" }, async () => ({
      id: "chatty", model: "gpt-5.5-nano",
      choices: [{ finish_reason: "stop", message: { content: `Here you go:\n${JSON.stringify({ presets })}\nHope that helps!` } }],
      usage,
    }));
    await expect(provider.generate(context)).resolves.toEqual(presets);
  });

  it("builds a real client when no call is injected", () => {
    expect(() => new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano" })).not.toThrow();
    expect(() => new CircuitNotionPresetsProvider({ apiKey: "cn_test", model: "gpt-5.5-nano", relaySecret: "s3cr3t" })).not.toThrow();
  });
});
