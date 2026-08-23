/**
 * Money, in more than one currency.
 *
 * Two facts force the design. Model providers publish prices in USD per million tokens, and this
 * product bills in RWF — so a cost is always *derived* from a foreign-currency rate, and the rate
 * is a fact about a moment in time. And a single request can cost a fraction of a US cent, so cents
 * are too coarse a unit to hold the intermediate arithmetic.
 *
 * Hence: amounts are integers in **micros** (one millionth of a major unit), and a conversion
 * cannot happen without an explicit, dated rate. There is no ambient exchange rate anywhere in this
 * module — a number without a currency is not money, and a conversion without a rate is a guess.
 */

/** ISO 4217 alphabetic currency code, validated at every CLI/configuration boundary. */
export type Currency = string;

export const CURRENCIES: readonly Currency[] = (() => {
  try {
    return Intl.supportedValuesOf("currency");
  } catch {
    return ["RWF", "USD"];
  }
})();

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

/** One millionth of a major unit — enough precision for per-request model costs. */
export const MICROS_PER_UNIT = 1_000_000;

export type Money = {
  /** Integer micros of `currency`. 1_500_000 micros = 1.50 USD. */
  micros: number;
  currency: Currency;
};

export function money(micros: number, currency: Currency): Money {
  if (!Number.isFinite(micros)) throw new Error("Money amount must be a finite number");
  return { micros: Math.round(micros), currency };
}

/** From a major-unit amount, e.g. `fromUnits(1.25, "USD")`. */
export function fromUnits(units: number, currency: Currency): Money {
  return money(units * MICROS_PER_UNIT, currency);
}

export function toUnits(value: Money): number {
  return value.micros / MICROS_PER_UNIT;
}

export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new Error(`Cannot add ${left.currency} to ${right.currency} without a rate`);
  return money(left.micros + right.micros, left.currency);
}

export function zero(currency: Currency): Money {
  return { micros: 0, currency };
}

/**
 * How much of one currency buys one of another, and when that was true.
 *
 * `asOf` is not decoration. A cost quoted at last year's rate is wrong by however much the currency
 * moved, and the only way anyone can audit a historical charge is if the rate that produced it was
 * recorded beside it. The gap register already calls for exactly this — "FX and catalog versions
 * must be attached to every quote".
 */
export type FxRate = {
  from: Currency;
  to: Currency;
  /** Units of `to` per one unit of `from`. */
  rate: number;
  /** When this rate was observed, as an ISO date. */
  asOf: string;
  /** Where it came from — a central bank, a provider invoice, a manual setting. */
  source: string;
};

export function convert(value: Money, rate: FxRate): Money {
  if (value.currency !== rate.from) throw new Error(`Rate converts ${rate.from}, not ${value.currency}`);
  if (!(rate.rate > 0)) throw new Error("Exchange rate must be positive");
  return money(value.micros * rate.rate, rate.to);
}

/** Converts when a usable rate exists, and says so plainly when one does not. */
export function convertTo(value: Money, target: Currency, rates: readonly FxRate[]): Money | undefined {
  if (value.currency === target) return value;
  const direct = rates.find((candidate) => candidate.from === value.currency && candidate.to === target);
  if (direct) return convert(value, direct);
  // An inverse is the same fact stated the other way round, and refusing to use it would mean
  // configuring RWF→USD and USD→RWF separately, which is two places for one number to go stale.
  const inverse = rates.find((candidate) => candidate.from === target && candidate.to === value.currency);
  if (inverse) return convert(value, { ...inverse, from: inverse.from === target ? value.currency : target, to: target, rate: 1 / inverse.rate });
  return undefined;
}

/**
 * Formatting rules per currency.
 *
 * RWF has no subunit in practice, so a fractional franc is noise. USD needs cents — and for model
 * costs, often more than cents: a request that costs $0.0004 should not display as $0.00, because
 * "free" and "very cheap" lead to different decisions.
 */
const FORMATS: Record<string, { symbol: string; minimumFractionDigits: number; maximumFractionDigits: number; smallThreshold: number; smallDigits: number }> = {
  RWF: { symbol: "RWF", minimumFractionDigits: 0, maximumFractionDigits: 0, smallThreshold: 0, smallDigits: 0 },
  USD: { symbol: "$", minimumFractionDigits: 2, maximumFractionDigits: 2, smallThreshold: 0.01, smallDigits: 4 },
};

export function formatMoney(value: Money): string {
  const format = FORMATS[value.currency];
  const units = toUnits(value);
  const magnitude = Math.abs(units);
  if (!format) {
    const digits = magnitude > 0 && magnitude < 0.01 ? 4 : 2;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: value.currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    }).format(units);
  }
  // Below the threshold, show enough digits for the number to mean something.
  const digits = magnitude > 0 && magnitude < format.smallThreshold ? format.smallDigits : format.maximumFractionDigits;
  const rendered = units.toLocaleString("en-US", { minimumFractionDigits: Math.min(format.minimumFractionDigits, digits), maximumFractionDigits: digits });
  return value.currency === "USD" ? `${format.symbol}${rendered}` : `${format.symbol} ${rendered}`;
}

/** Price of a model's tokens, in the currency the provider actually publishes. */
export type TokenPrices = {
  currency: Currency;
  /** Micros per million input tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
  /** Providers that serve cached input at a discount publish it here. */
  cachedInputPerMillion?: number;
  /** Whole-request multipliers applied once an input-token threshold is exceeded. */
  largeContext?: {
    aboveInputTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
};

export function tokenPrices(currency: Currency, input: number, output: number, cachedInput?: number, largeContext?: TokenPrices["largeContext"]): TokenPrices {
  return {
    currency,
    inputPerMillion: Math.round(input * MICROS_PER_UNIT),
    outputPerMillion: Math.round(output * MICROS_PER_UNIT),
    ...(cachedInput !== undefined ? { cachedInputPerMillion: Math.round(cachedInput * MICROS_PER_UNIT) } : {}),
    ...(largeContext ? { largeContext } : {}),
  };
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

/**
 * What a request cost, in the provider's own currency.
 *
 * Cached tokens are a subset of input tokens, never an addition — every provider reports them that
 * way, and treating them as extra would double-count the cheapest part of a long session.
 */
export function priceUsage(usage: TokenUsage, prices: TokenPrices): Money {
  const tier = prices.largeContext && usage.inputTokens > prices.largeContext.aboveInputTokens
    ? prices.largeContext
    : undefined;
  const inputMultiplier = tier?.inputMultiplier ?? 1;
  const outputMultiplier = tier?.outputMultiplier ?? 1;
  const cached = prices.cachedInputPerMillion === undefined ? 0 : Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const micros =
    (uncached * prices.inputPerMillion * inputMultiplier) / 1_000_000 +
    (cached * (prices.cachedInputPerMillion ?? 0) * inputMultiplier) / 1_000_000 +
    (usage.outputTokens * prices.outputPerMillion * outputMultiplier) / 1_000_000;
  return money(micros, prices.currency);
}
