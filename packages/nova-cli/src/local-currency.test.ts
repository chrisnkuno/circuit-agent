import { describe, expect, it, vi } from "vitest";
import { countryFromEnvironment, fetchDailyFxRate, resolveCurrencyPreference } from "./local-currency";

describe("CLI local currency preference", () => {
  it("detects a country from standard locale variables", () => {
    expect(countryFromEnvironment({ LANG: "ar_EG.UTF-8" }, "Etc/UTC")).toBe("EG");
    expect(resolveCurrencyPreference({ environment: { TZ: "Africa/Cairo", LANG: "en_US.UTF-8" }, providerCurrency: "USD" })).toMatchObject({ currency: "EGP", countryCode: "EG", source: "location" });
  });

  it("prefers explicit currency, then environment configuration, over automatic locale", () => {
    expect(resolveCurrencyPreference({ currency: "GBP", country: "GB", environment: { LANG: "ar_EG.UTF-8" }, providerCurrency: "USD" }).currency).toBe("GBP");
    expect(resolveCurrencyPreference({ environment: { NOVA_CURRENCY: "EUR", LANG: "ar_EG.UTF-8" }, providerCurrency: "USD" }).currency).toBe("EUR");
  });

  it("falls back to provider currency when location cannot be mapped", () => {
    expect(resolveCurrencyPreference({ environment: { LANG: "C.UTF-8", TZ: "Etc/UTC" }, providerCurrency: "USD" })).toMatchObject({ currency: "USD", source: "provider" });
  });
});

describe("daily FX lookup", () => {
  it("returns a dated rate from the requested provider currency to local currency", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ date: "2026-08-08", usd: { egp: 48.5 } }), { status: 200 }));
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch)).resolves.toEqual({
      from: "USD", to: "EGP", rate: 48.5, asOf: "2026-08-08", source: "fawazahmed0/exchange-api daily rate",
    });
  });

  it("fails safely without inventing a conversion", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
