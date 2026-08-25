import { describe, expect, it, vi } from "vitest";
import { buildDoctorEndpoints, doctorExitCode, doctorReport, renderDoctor, runDoctor } from "./doctor";

function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 200, headers: { "x-request-id": "req-doctor" } }));
}

describe("connectivity doctor", () => {
  it("builds one probe per provider, FX host, and update registry", () => {
    const endpoints = buildDoctorEndpoints({ CIRCUITNOTION_API_KEY: "sk-test" });
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "provider:circuitnotion", "provider:openai", "provider:anthropic", "provider:ollama",
      "fx:0", "fx:1", "update",
    ]);
    expect(endpoints.find((endpoint) => endpoint.id === "provider:circuitnotion")).toMatchObject({
      required: true,
      configured: true,
      url: "https://api.circuitnotion.com/v1/models",
    });
    expect(endpoints.find((endpoint) => endpoint.id === "provider:openai")).toMatchObject({ required: false, configured: false });
    // Ollama needs no key, so it is always "configured" — but a local daemon nobody started is
    // not a failure, so it is never "required".
    expect(endpoints.find((endpoint) => endpoint.id === "provider:ollama")).toMatchObject({ required: false, configured: true });
  });

  it("reports every endpoint reachable when the network answers", async () => {
    const fetchImpl = okFetch();
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    expect(probes.every((probe) => probe.ok || probe.skipped)).toBe(true);
    expect(probes.filter((probe) => probe.skipped)).toHaveLength(2); // unconfigured providers
    expect(doctorExitCode(probes)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5); // 1 configured provider + Ollama + 2 FX + 1 registry
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
      return new Response(null, { status: 200 });
    });
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    expect(doctorExitCode(probes)).toBe(0);
    expect(probes.find((probe) => probe.id === "fx:0")?.ok).toBe(false);
    expect(probes.find((probe) => probe.id === "provider:circuitnotion")?.ok).toBe(true);
  });

  it("fails on an HTTP 500 even though the host answered, and keeps its request id", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.circuitnotion.com")) {
        return new Response(null, { status: 500, headers: { "x-request-id": "req-backend-500" } });
      }
      return new Response(null, { status: 200 });
    });
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl });
    expect(probes.find((probe) => probe.id === "provider:circuitnotion")).toMatchObject({
      ok: false, status: 500, requestId: "req-backend-500", diagnosis: { kind: "server_error" },
    });
    expect(doctorExitCode(probes)).toBe(1);
  });

  it("uses a monotonic clock and never renders a negative duration", async () => {
    const ticks = [100, 90, 200, 190, 300, 290, 400, 390, 500, 490];
    const probes = await runDoctor({ CIRCUITNOTION_API_KEY: "sk-test" }, { fetchImpl: okFetch(), now: () => ticks.shift() ?? 0 });
    expect(probes.every((probe) => probe.ms === undefined || probe.ms >= 0)).toBe(true);
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
    expect(model?.url).toBe("https://relay.example.com/v1/models");
  });

  it("creates an allowlisted support report without credentials or endpoint URLs", () => {
    const report = doctorReport([{
      id: "provider:circuitnotion",
      purpose: "model API · CircuitNotion",
      url: "https://user:secret@relay.example.com/v1/models?key=do-not-leak",
      headers: { Authorization: "Bearer do-not-leak" },
      required: true,
      configured: true,
      ok: false,
      status: 500,
      requestId: "req-safe-to-share",
      diagnosis: { kind: "server_error", message: "The provider returned HTTP 500." },
    }], {
      cliVersion: "1.2.3",
      platform: "linux",
      arch: "x64",
      runtime: "Bun 1.3.0",
      provider: "circuitnotion",
      model: "test-model",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).toContain("relay.example.com");
    expect(serialized).toContain("req-safe-to-share");
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("/v1/models");
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
