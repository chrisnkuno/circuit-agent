import { describe, expect, it } from "vitest";
import { credentialsFor, defaultBaseUrl, providerIsConfigured, settingsToEnvironment } from "./settings.js";
import type { NovaSettings } from "./protocol.js";

/**
 * One key, three providers — the shape that made "switch model" a trap.
 *
 * Choosing a model from a provider you have no key for did not fail when you chose it: the switch
 * only checks that *a* key is present, so it succeeded, reported the new model, and then failed on
 * the next turn. Worse than the key was the base URL, which stayed pointed at the previous
 * provider — so Anthropic requests were addressed to CircuitNotion's host under Anthropic's name.
 *
 * Every test here is a statement that a provider's credentials belong to that provider.
 */

const base = (patch: Partial<NovaSettings> = {}): NovaSettings => ({
  provider: "circuitnotion",
  apiKey: "cn-key",
  baseUrl: "https://api.circuitnotion.com/v1",
  model: "gpt-5.6-luna",
  ...patch,
});

describe("credentials per provider", () => {
  it("gives the selected provider the flat key an older build stored", () => {
    // Migration: settings written before `credentials` existed must keep working untouched.
    expect(credentialsFor(base(), "circuitnotion").apiKey).toBe("cn-key");
  });

  it("does not hand that key to a provider it was never issued for", () => {
    expect(credentialsFor(base(), "anthropic").apiKey).toBe("");
    expect(credentialsFor(base(), "openai").apiKey).toBe("");
  });

  it("uses each provider's own key once one is stored", () => {
    const settings = base({ credentials: { anthropic: { apiKey: "sk-ant" }, openai: { apiKey: "sk-oai" } } });
    expect(credentialsFor(settings, "anthropic").apiKey).toBe("sk-ant");
    expect(credentialsFor(settings, "openai").apiKey).toBe("sk-oai");
    expect(credentialsFor(settings, "circuitnotion").apiKey).toBe("cn-key");
  });

  it("falls back to each provider's own default base URL, never the previous one's", () => {
    // The failure worth naming: an Anthropic request addressed to CircuitNotion's host.
    expect(credentialsFor(base(), "anthropic").baseUrl).toBe(defaultBaseUrl("anthropic"));
    expect(credentialsFor(base(), "openai").baseUrl).toBe("https://api.openai.com/v1");
  });

  it("keeps a custom base URL with the provider it was entered for", () => {
    const settings = base({ credentials: { openai: { apiKey: "sk-oai", baseUrl: "https://gateway.internal/v1" } } });
    expect(credentialsFor(settings, "openai").baseUrl).toBe("https://gateway.internal/v1");
    expect(credentialsFor(settings, "circuitnotion").baseUrl).toBe("https://api.circuitnotion.com/v1");
  });

  it("reports which providers can actually be used", () => {
    const settings = base({ credentials: { anthropic: { apiKey: "sk-ant" } } });
    expect(providerIsConfigured(settings, "circuitnotion")).toBe(true);
    expect(providerIsConfigured(settings, "anthropic")).toBe(true);
    expect(providerIsConfigured(settings, "openai")).toBe(false);
  });

  it("treats whitespace as no key at all", () => {
    expect(providerIsConfigured(base({ apiKey: "   " }), "circuitnotion")).toBe(false);
  });
});

describe("the environment the engine is given", () => {
  it("passes the selected provider's own key and host", () => {
    const settings = base({
      provider: "anthropic",
      apiKey: "sk-ant",
      baseUrl: "",
      model: "claude-sonnet-5",
      credentials: { circuitnotion: { apiKey: "cn-key", baseUrl: "https://api.circuitnotion.com/v1" } },
    });
    const env = settingsToEnvironment(settings);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    // And carries nothing belonging to the provider that is not selected.
    expect(env.CIRCUITNOTION_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL ?? "").not.toContain("circuitnotion");
  });

  it("keeps the relay secret with CircuitNotion, where it is meaningful", () => {
    const env = settingsToEnvironment(base({ relaySecret: "shh" }));
    expect(env.CIRCUITNOTION_RELAY_SECRET).toBe("shh");
    expect(settingsToEnvironment(base({ provider: "openai", relaySecret: "shh" })).CIRCUITNOTION_RELAY_SECRET).toBeUndefined();
  });
});

/**
 * Billing reaches the engine under the same two names the CLI reads.
 *
 * The desktop could have invented its own pair of variables and wired them straight to a gateway.
 * It reads `NOVA_BILLING_URL` / `NOVA_BILLING_KEY` instead, because it is one account: someone who
 * configured paying in the terminal should not have to discover a second place to configure it,
 * and `billingFromEnvironment` — which is what actually decides whether a balance can be read —
 * only ever looks for those two.
 */
describe("billing credentials", () => {
  it("passes both billing variables through under the names the engine reads", () => {
    const env = settingsToEnvironment(base({ billingUrl: "https://pay.example", billingKey: "pk-1" }));
    expect(env.NOVA_BILLING_URL).toBe("https://pay.example");
    expect(env.NOVA_BILLING_KEY).toBe("pk-1");
  });

  it("leaves them absent rather than empty when unconfigured", () => {
    // `billingFromEnvironment` returns null on a missing variable and a gateway on an empty one,
    // so an empty string here is the difference between "no billing configured" and a client that
    // half-exists and fails on first use.
    const env = settingsToEnvironment(base());
    expect("NOVA_BILLING_URL" in env).toBe(false);
    expect("NOVA_BILLING_KEY" in env).toBe(false);
  });

  it("treats whitespace as unconfigured", () => {
    const env = settingsToEnvironment(base({ billingUrl: "   ", billingKey: "  " }));
    expect("NOVA_BILLING_URL" in env).toBe(false);
    expect("NOVA_BILLING_KEY" in env).toBe(false);
  });
});
