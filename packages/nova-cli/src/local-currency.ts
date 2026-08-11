import { isCurrency, type Currency, type FxRate } from "@circuit-nova/nova-core/money";

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

/**
 * The countries a location can be set to, in the sense that matters: ones we can price in.
 *
 * Exported so settings can refuse a code that would change nothing. Accepting `XX` and then
 * silently falling back to the provider's currency is the worst outcome available — the user has
 * told Nova where they are, seen it saved, and gets dollars anyway with no indication why.
 */
export const SUPPORTED_COUNTRIES: readonly string[] = Object.keys(COUNTRY_CURRENCIES).sort();

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

const FX_ENDPOINTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies",
  "https://latest.currency-api.pages.dev/v1/currencies",
];

/** Fetches one dated daily rate, with the provider's documented fallback host. */
export async function fetchDailyFxRate(
  from: Currency,
  to: Currency,
  fetchImpl: typeof fetch = fetch,
): Promise<FxRate | null> {
  if (from === to) return null;
  const base = from.toLowerCase();
  const target = to.toLowerCase();
  for (const endpoint of FX_ENDPOINTS) {
    try {
      const response = await fetchImpl(`${endpoint}/${base}.json`, { signal: AbortSignal.timeout(4_000) });
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
    } catch {
      // Continue to the fallback host. Offline callers receive null and retain provider currency.
    }
  }
  return null;
}
