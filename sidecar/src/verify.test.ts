import { describe, expect, it } from "vitest";
import { verifyCredentials } from "./verify.js";
import type { NovaSettings } from "./protocol.js";

const base: NovaSettings = {
  provider: "circuitnotion",
  apiKey: "sk-test",
  baseUrl: "https://api.circuitnotion.com/v1",
  model: "gpt-5.6-luna",
};

/** A fetch that records what it was asked and answers with a fixed response. */
function stubFetch(response: { status?: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (response instanceof Error) throw response;
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("verifying credentials before they are saved", () => {
  it("reports success and how many models the key can see", async () => {
    const { impl } = stubFetch({ body: { data: [{ id: "gpt-5.6-luna" }, { id: "gpt-4o" }] } });
    expect(await verifyCredentials(base, impl)).toEqual({ ok: true, models: 2 });
  });

  it("asks the provider's model list, which costs nothing", async () => {
    // The point of using /models is that no tokens are generated, so checking a key is free.
    const { impl, calls } = stubFetch({ body: { data: [] } });
    await verifyCredentials(base, impl);
    expect(calls[0].url).toBe("https://api.circuitnotion.com/v1/models");
  });

  it("authenticates the way each provider expects", async () => {
    const openai = stubFetch({ body: { data: [] } });
    await verifyCredentials({ ...base, provider: "openai", baseUrl: "https://api.openai.com/v1" }, openai.impl);
    expect(openai.calls[0].headers.authorization).toBe("Bearer sk-test");

    // Anthropic uses a different header and requires a version, so a Bearer token would 401 and
    // look exactly like a bad key.
    const anthropic = stubFetch({ body: { data: [] } });
    await verifyCredentials({ ...base, provider: "anthropic", baseUrl: "" }, anthropic.impl);
    expect(anthropic.calls[0].headers["x-api-key"]).toBe("sk-test");
    expect(anthropic.calls[0].headers["anthropic-version"]).toBeTruthy();
    expect(anthropic.calls[0].url).toBe("https://api.anthropic.com/v1/models");
  });

  it("passes the relay secret when one is configured", async () => {
    const { impl, calls } = stubFetch({ body: { data: [] } });
    await verifyCredentials({ ...base, relaySecret: "shh" }, impl);
    expect(calls[0].headers["x-relay-secret"]).toBe("shh");
  });

  it("does not double the /v1 when the base URL already has it", async () => {
    const { impl, calls } = stubFetch({ body: { data: [] } });
    await verifyCredentials({ ...base, provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }, impl);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { impl, calls } = stubFetch({ body: { data: [] } });
    await verifyCredentials({ ...base, baseUrl: "https://api.circuitnotion.com/v1/" }, impl);
    expect(calls[0].url).toBe("https://api.circuitnotion.com/v1/models");
  });

  it("separates a rejected key from a wrong URL from an outage", async () => {
    // Each of these needs a different action from the user, so reporting them alike would be
    // telling them nothing.
    const rejected = await verifyCredentials(base, stubFetch({ status: 401 }).impl);
    expect(rejected).toMatchObject({ ok: false });
    if (rejected.ok) throw new Error("expected failure");
    expect(rejected.reason).toContain("rejected");

    const notFound = await verifyCredentials(base, stubFetch({ status: 404 }).impl);
    if (notFound.ok) throw new Error("expected failure");
    expect(notFound.reason).toContain("base URL");

    const outage = await verifyCredentials(base, stubFetch({ status: 503 }).impl);
    if (outage.ok) throw new Error("expected failure");
    expect(outage.hint).toContain("Nothing is wrong with your settings");
  });

  it("treats a rate limit as a working key, because it is one", async () => {
    const limited = await verifyCredentials(base, stubFetch({ status: 429 }).impl);
    if (limited.ok) throw new Error("expected a reported failure with a reassuring hint");
    expect(limited.reason).toContain("valid");
  });

  it("says so when the key works but the configured model is not offered", async () => {
    // A working key pointed at a model the provider does not have is still a broken setup, and it
    // would otherwise only surface on the first real turn.
    const { impl } = stubFetch({ body: { data: [{ id: "gpt-4o" }] } });
    const result = await verifyCredentials({ ...base, model: "not-a-model" }, impl);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected success with a note");
    expect(result.note).toContain("not-a-model");
  });

  it("never throws, whatever the network does", async () => {
    // This answers a question on a form the user is still filling in; an exception would surface
    // as a crash mid-typing.
    const offline = await verifyCredentials(base, stubFetch(new Error("getaddrinfo ENOTFOUND")).impl);
    expect(offline).toMatchObject({ ok: false });
    if (offline.ok) throw new Error("expected failure");
    expect(offline.reason).toContain("Could not reach");

    const timedOut = await verifyCredentials(base, stubFetch(new Error("The operation was aborted due to timeout")).impl);
    if (timedOut.ok) throw new Error("expected failure");
    expect(timedOut.reason).toContain("did not answer in time");
  });

  it("declines to check an empty key rather than calling the network", async () => {
    const { impl, calls } = stubFetch({ body: { data: [] } });
    expect(await verifyCredentials({ ...base, apiKey: "  " }, impl)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});
