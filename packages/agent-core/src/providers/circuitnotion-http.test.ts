import { describe, expect, it } from "vitest";
import { CIRCUITNOTION_DEFAULT_BASE_URL, buildCircuitNotionHeaders, circuitNotionBaseUrl } from "./circuitnotion-http";

/**
 * The headers every CircuitNotion call carries.
 *
 * The relay secret is the interesting one: the Cloudflare Worker that gives these calls an edge
 * egress path rejects any request without it, which is the only thing standing between that Worker
 * and being a general-purpose open proxy for CircuitNotion's API. Sending it when there is no relay
 * would leak it to the vendor; omitting it when there is one is a 403 that looks like a bad key.
 */

describe("CircuitNotion request headers", () => {
  it("sends the relay secret only when a relay is configured", () => {
    expect(buildCircuitNotionHeaders("shh")["x-relay-secret"]).toBe("shh");
    expect(buildCircuitNotionHeaders()).not.toHaveProperty("x-relay-secret");
    expect(buildCircuitNotionHeaders("")).not.toHaveProperty("x-relay-secret");
  });

  it("always identifies itself, since the WAF in front of the API judges requests that do not", () => {
    expect(buildCircuitNotionHeaders()["User-Agent"]?.length).toBeGreaterThan(20);
  });

  it("defaults to a versioned HTTPS base URL", () => {
    expect(CIRCUITNOTION_DEFAULT_BASE_URL.startsWith("https://")).toBe(true);
    expect(CIRCUITNOTION_DEFAULT_BASE_URL.endsWith("/v1")).toBe(true);
  });

  it("adds the version route to the public origin without rewriting a custom relay path", () => {
    expect(circuitNotionBaseUrl("https://api.circuitnotion.com")).toBe("https://api.circuitnotion.com/v1");
    expect(circuitNotionBaseUrl("https://api.circuitnotion.com/")).toBe("https://api.circuitnotion.com/v1");
    expect(circuitNotionBaseUrl("https://relay.example.com/openai")).toBe("https://relay.example.com/openai");
  });
});
