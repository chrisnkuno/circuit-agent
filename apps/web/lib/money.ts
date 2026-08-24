import { formatRwf } from "./task-cost";

export type CurrencySource = "automatic" | "manual";
export type MoneyPreference = { countryCode: string; currencyCode: string; source: CurrencySource };

export const COUNTRY_OPTIONS = [
  ["RW", "Rwanda", "RWF"], ["EG", "Egypt", "EGP"], ["KE", "Kenya", "KES"],
  ["UG", "Uganda", "UGX"], ["TZ", "Tanzania", "TZS"], ["NG", "Nigeria", "NGN"],
  ["ZA", "South Africa", "ZAR"], ["GH", "Ghana", "GHS"], ["ET", "Ethiopia", "ETB"],
  ["US", "United States", "USD"], ["CA", "Canada", "CAD"], ["GB", "United Kingdom", "GBP"],
  ["FR", "France", "EUR"], ["DE", "Germany", "EUR"], ["ES", "Spain", "EUR"],
  ["IT", "Italy", "EUR"], ["NL", "Netherlands", "EUR"], ["BE", "Belgium", "EUR"],
  ["CH", "Switzerland", "CHF"], ["SE", "Sweden", "SEK"], ["NO", "Norway", "NOK"],
  ["DK", "Denmark", "DKK"], ["PL", "Poland", "PLN"], ["CZ", "Czechia", "CZK"],
  ["TR", "Turkiye", "TRY"], ["AE", "United Arab Emirates", "AED"], ["SA", "Saudi Arabia", "SAR"],
  ["IL", "Israel", "ILS"], ["IN", "India", "INR"], ["CN", "China", "CNY"],
  ["JP", "Japan", "JPY"], ["SG", "Singapore", "SGD"], ["AU", "Australia", "AUD"],
  ["NZ", "New Zealand", "NZD"], ["BR", "Brazil", "BRL"], ["MX", "Mexico", "MXN"],
] as const;

const currencyByCountry = new Map<string, string>(COUNTRY_OPTIONS.map(([country, , currency]) => [country, currency]));

const mappedCurrencies = Array.from(new Set(COUNTRY_OPTIONS.map(([, , currency]) => currency)));
export const CURRENCY_OPTIONS = (() => {
  try {
    // Modern browsers expose the full ISO currency list. The mapped fallback still keeps the
    // selector useful in older engines, while automatic country defaults remain deliberately
    // limited to currencies we can map with confidence.
    return Intl.supportedValuesOf("currency");
  } catch {
    return mappedCurrencies.sort();
  }
})();

export function currencyForCountry(countryCode: string): string | null {
  return currencyByCountry.get(countryCode.toUpperCase()) ?? null;
}

export function countryFromLocale(locale: string | undefined): string | null {
  if (!locale) return null;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region && currencyForCountry(region) ? region : null;
  } catch {
    return null;
  }
}

export function formatConvertedRwf(valueRwf: number, currencyCode: string, rate: number | null, locale?: string): string {
  if (currencyCode === "RWF") return formatRwf(valueRwf);
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return formatRwf(valueRwf);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: Math.abs(valueRwf * rate) < 10 ? 2 : 0,
  }).format(valueRwf * rate);
}
