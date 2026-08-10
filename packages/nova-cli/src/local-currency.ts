import { isCurrency, type Currency, type FxRate } from "@circuit-nova/nova-core/money";
import { FX_ENDPOINTS, hostOf } from "./endpoints";
import { classifyNetworkError, type NetworkDiagnosis } from "./network";

const COUNTRY_CURRENCIES: Record<string, Currency> = {
  RW: "RWF", EG: "EGP", KE: "KES", UG: "UGX", TZ: "TZS", NG: "NGN", ZA: "ZAR", GH: "GHS", ET: "ETB",
  US: "USD", CA: "CAD", GB: "GBP", FR: "EUR", DE: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", TR: "TRY", AE: "AED", SA: "SAR",
  IL: "ILS", IN: "INR", CN: "CNY", JP: "JPY", SG: "SGD", AU: "AUD", NZ: "NZD", BR: "BRL", MX: "MXN",
};

const TIMEZONE_COUNTRIES: Record<string, string> = {
  "Africa/Cairo": "EG", "Africa/Kigali": "RW", "Africa/Nairobi": "KE", "Africa/Kampala": "UG", "Africa/Dar_es_Salaam": "TZ",
  "Africa/Lagos": "NG", "Africa/Johannesburg": "ZA", "Africa/Accra": "GH", "Africa/Addis_Ababa": "ET",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "Europe/London": "GB", "Europe/Paris": "FR", "Europe/Berlin": "DE",
  "Europe/Madrid": "ES", "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Zurich": "CH",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
  "Europe/Istanbul": "TR", "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Jerusalem": "IL", "Asia/Kolkata": "IN",
  "Asia/Shanghai": "CN", "Asia/Tokyo": "JP", "Asia/Singapore": "SG", "Australia/Sydney": "AU", "Pacific/Auckland": "NZ",
  "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
};

export type CurrencyPreference = {
  currency: Currency;
  countryCode: string | null;
  source: "flag" | "environment" | "location" | "provider";
};

export function normalizeCountryCode(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function currencyForCountry(countryCode: string | null): Currency | null {
  return countryCode ? COUNTRY_CURRENCIES[countryCode] ?? null : null;
}

/** Reads only coarse locale metadata already present in the process; no coordinates are collected. */
export function countryFromEnvironment(
  environment: Record<string, string | undefined>,
  systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  const explicit = normalizeCountryCode(environment.NOVA_COUNTRY);
  if (explicit) return explicit;
  const timezoneCountry = TIMEZONE_COUNTRIES[environment.TZ?.trim() || systemTimeZone];
  if (timezoneCountry) return timezoneCountry;
  for (const key of ["LC_MONETARY", "LC_ALL", "LANG"] as const) {
    const locale = environment[key]?.trim();
    if (!locale || locale === "C" || locale.startsWith("C.")) continue;
    try {
      const normalizedLocale = locale.split(".")[0].split("@")[0].replaceAll("_", "-");
      const country = normalizeCountryCode(new Intl.Locale(normalizedLocale).region);
      if (country) return country;
    } catch {
      // Try the next standard locale variable rather than guessing from malformed text.
    }
  }
  return null;
}

export function resolveCurrencyPreference(options: {
  currency?: string;
  country?: string;
  environment: Record<string, string | undefined>;
  providerCurrency: Currency;
}): CurrencyPreference {
  const flagCurrency = options.currency?.trim().toUpperCase();
  if (flagCurrency && isCurrency(flagCurrency)) {
    return { currency: flagCurrency, countryCode: normalizeCountryCode(options.country), source: "flag" };
  }
  const environmentCurrency = options.environment.NOVA_CURRENCY?.trim().toUpperCase();
  const countryCode = normalizeCountryCode(options.country) ?? countryFromEnvironment(options.environment);
  if (environmentCurrency && isCurrency(environmentCurrency)) {
    return { currency: environmentCurrency, countryCode, source: "environment" };
  }
  const localCurrency = currencyForCountry(countryCode);
  if (localCurrency) return { currency: localCurrency, countryCode, source: "location" };
  return { currency: options.providerCurrency, countryCode, source: "provider" };
}

const FX_TIMEOUT_MS = 3_000;

export type FxLookupFailure = {
  host: string;
  diagnosis: NetworkDiagnosis;
};

/**
 * Fetches one dated daily rate, with the provider's documented fallback host.
 *
 * The lookup is strictly optional: it returns null (never throws) when neither host answers, and
 * every failure is reported through `onFailure` so the caller can tell the user *why* the rate is
 * missing instead of silently falling back or blaming the whole internet. The timeout is kept
 * short because this runs during CLI startup — a blocked CDN must not hold up a session for half
 * a minute while the model API itself is fine.
 */
export async function fetchDailyFxRate(
  from: Currency,
  to: Currency,
  fetchImpl: typeof fetch = fetch,
  onFailure?: (failure: FxLookupFailure) => void,
): Promise<FxRate | null> {
  if (from === to) return null;
  const base = from.toLowerCase();
  const target = to.toLowerCase();
  for (const endpoint of FX_ENDPOINTS) {
    const host = hostOf(endpoint);
    try {
      const response = await fetchImpl(`${endpoint}/${base}.json`, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
      if (!response.ok) continue;
      const payload = await response.json() as { date?: unknown; [key: string]: unknown };
      const rates = payload[base];
      const rate = rates && typeof rates === "object" ? (rates as Record<string, unknown>)[target] : undefined;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
      return {
        from,
        to,
        rate,
        asOf: typeof payload.date === "string" ? payload.date : new Date().toISOString().slice(0, 10),
        source: "fawazahmed0/exchange-api daily rate",
      };
    } catch (error) {
      // Report and continue to the fallback host. Offline callers receive null and retain
      // provider currency, with a diagnosis instead of a dead silence.
      onFailure?.({
        host,
        diagnosis: classifyNetworkError(error, { host, purpose: "the FX rate lookup" })
          ?? { kind: "reset", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return null;
}
