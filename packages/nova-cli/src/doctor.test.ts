import { describe, expect, it, vi } from "vitest";
import { buildDoctorEndpoints, doctorExitCode, renderDoctor, runDoctor } from "./doctor";

function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 404 }));
}

describe("connectivity doctor", () => {
  it("builds one probe per provider, FX host, and update registry", () => {
    const endpoints = buildDoctorEndpoints({ CIRCUITNOTION_API_KEY: "sk-test" });
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "provider:circuitnotion", "provider:openai", "provider:anthropic",
      "fx:0", "fx:1", "update",
    ]);
    expect(endpoints.find((endpoint) => endpoint.id === "provider:circuitnotion")).toMatchObject({
      required: true,
      configured: true,
      url: "https://api.circuitnotion.com/v1",
    });
    expect(endpoints.find((endpoint) => endpoint.id === "provider:openai")).toMatchObject({ required: false, configured: false });
  });

  it("reports every endpoint reachable when the network answers", async () => {
    const fetchImpl = okFetch();
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    expect(probes.every((probe) => probe.ok || probe.skipped)).toBe(true);
    expect(probes.filter((probe) => probe.skipped)).toHaveLength(2); // unconfigured providers
    expect(doctorExitCode(probes)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 configured provider + 2 FX + 1 registry
  });

  it("fails the doctor when a configured provider's API is unreachable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.circuitnotion.com")) throw transportError("getaddrinfo ENOTFOUND api.circuitnotion.com", "ENOTFOUND");
      return new Response(null, { status: 404 });
    });
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    const model = probes.find((probe) => probe.id === "provider:circuitnotion");
    expect(model?.ok).toBe(false);
    expect(model?.diagnosis?.kind).toBe("dns");
    expect(doctorExitCode(probes)).toBe(1);
  });

  it("stays green when only an optional endpoint fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("currency-api")) throw transportError("connect ETIMEDOUT", "ETIMEDOUT");
      return new Response(null, { status: 404 });
    });
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    expect(doctorExitCode(probes)).toBe(0);
    expect(probes.find((probe) => probe.id === "fx:0")?.ok).toBe(false);
    expect(probes.find((probe) => probe.id === "provider:circuitnotion")?.ok).toBe(true);
  });

  it("passes when no provider is configured, and says so", async () => {
    const probes = await runDoctor({}, { fetchImpl: okFetch() });
    expect(doctorExitCode(probes)).toBe(0);
    const rendered = renderDoctor(probes, "none");
    expect(rendered).toContain("No provider is configured");
  });

  it("renders a verdict naming the failing host", () => {
    const probes = runDoctorWithFailure();
    const rendered = renderDoctor(probes, "none");
    expect(rendered).toContain("Nova connectivity check");
    expect(rendered).toContain("api.circuitnotion.com");
    expect(rendered).toContain("cannot reach its model provider");
  });

  it("honours a custom base URL", async () => {
    const probes = await runDoctor(
      { CIRCUITNOTION_API_KEY: "sk-test", CIRCUITNOTION_BASE_URL: "https://relay.example.com/v1" },
      { fetchImpl: okFetch() },
    );
    const model = probes.find((probe) => probe.id === "provider:circuitnotion");
    expect(model?.url).toBe("https://relay.example.com/v1");
  });
});

function runDoctorWithFailure() {
  const model: Parameters<typeof renderDoctor>[0][number] = {
    id: "provider:circuitnotion",
    purpose: "model API · CircuitNotion",
    url: "https://api.circuitnotion.com/v1",
    required: true,
    configured: true,
    ok: false,
    ms: 14,
    diagnosis: { kind: "dns", message: "Could not resolve api.circuitnotion.com", hint: "Check the base URL." },
  };
  return [model];
}
