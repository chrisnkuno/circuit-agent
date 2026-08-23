import { money, tokenPrices, type Currency, type Money, type TokenPrices } from "./money";

/**
 * What things cost, scoped to a model and dated.
 *
 * Two properties are load-bearing, and both were missing while prices lived as bare constants.
 *
 * **Scoped.** A price belongs to one provider's one model. A single global "input rate" is wrong
 * the moment a session switches models — the old rate silently keeps pricing the new model, and
 * the number still looks plausible, which is the worst kind of wrong.
 *
 * **Dated.** A published rate is a fact about a period, not a constant. Anthropic's Sonnet 5 is on
 * an introductory rate that ends 2026-08-31; a catalog with one number for it is either wrong today
 * or wrong in September. `effectiveFrom`/`effectiveUntil` let both truths sit in the table at once
 * and let a cost quoted last month still be reconstructed from the rate that produced it.
 *
 * The same record prices non-model meters — a search request, a sandbox second — because the ledger
 * has to add them to model tokens to answer "what did this task cost", and a second parallel price
 * format would be a second place for rates to go stale.
 */

/** What is being metered. Determines which `rates` keys are meaningful, not how they are charged. */
export type PriceModality = "text" | "embedding" | "image" | "audio" | "search" | "compute";

/** What the provider counts. */
export type BillingUnit = "tokens" | "requests" | "pages" | "images" | "seconds" | "characters";

export type PriceRecord = {
  provider: string;
  /**
   * The model id for model pricing, or the meter name for everything else ("search", "sandbox").
   * One field rather than two because the lookup is the same either way and a nullable
   * `model`/`service` pair invites records that set neither.
   */
  model: string;
  modality: PriceModality;
  currency: Currency;
  billingUnit: BillingUnit;
  /**
   * How many billing units one quoted rate covers — 1_000_000 for per-million-token pricing,
   * 1_000 for Exa's per-thousand-request pricing, 1 for a per-second rate.
   *
   * Quoting rates in the provider's own denominator is deliberate: a rate normalised to "per unit"
   * becomes a long decimal that nobody can check against a published price page, and checking
   * against the price page is the only way anyone catches a wrong entry.
   */
  per: number;
  /**
   * Rate per `per` units, in major units of `currency`, keyed by meter.
   *
   * Token models use `input`, `output` and optionally `cachedInput`. Other modalities name their
   * own meters — Exa charges `request` and `contents` separately, and they are billed per different
   * denominators of the same call.
   */
  rates: Readonly<Record<string, number>>;
  /** A provider may multiply the whole token request after an input-context threshold. */
  largeContext?: TokenPrices["largeContext"];
  /** Where the number came from, so a disputed charge has somewhere to be checked against. */
  source: string;
  /** ISO date this rate began applying. */
  effectiveFrom: string;
  /** ISO date it stopped applying, exclusive. Absent means "still current". */
  effectiveUntil?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date (YYYY-MM-DD), got "${value}"`);
}

/**
 * Rejects a record that cannot price anything, at the point it enters the catalog.
 *
 * A malformed price does not fail loudly on its own — it produces a number. Validating on the way
 * in is the only place the failure is still attributable to the entry that caused it.
 */
export function validatePriceRecord(record: PriceRecord): PriceRecord {
  if (!record.provider.trim()) throw new Error("Price record needs a provider");
  if (!record.model.trim()) throw new Error("Price record needs a model or meter name");
  if (!record.source.trim()) throw new Error(`Price for ${record.provider}/${record.model} needs a source`);
  if (!Number.isFinite(record.per) || record.per <= 0) throw new Error(`Price for ${record.provider}/${record.model} needs a positive "per"`);
  assertDate(record.effectiveFrom, `effectiveFrom for ${record.provider}/${record.model}`);
  if (record.effectiveUntil !== undefined) {
    assertDate(record.effectiveUntil, `effectiveUntil for ${record.provider}/${record.model}`);
    if (record.effectiveUntil <= record.effectiveFrom) throw new Error(`Price for ${record.provider}/${record.model} ends before it starts`);
  }
  const meters = Object.entries(record.rates);
  if (meters.length === 0) throw new Error(`Price for ${record.provider}/${record.model} has no rates`);
  for (const [meter, rate] of meters) {
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`Rate "${meter}" for ${record.provider}/${record.model} must be a non-negative number`);
  }
  if (record.largeContext) {
    const { aboveInputTokens, inputMultiplier, outputMultiplier } = record.largeContext;
    if (!Number.isSafeInteger(aboveInputTokens) || aboveInputTokens < 0) throw new Error(`Large-context threshold for ${record.provider}/${record.model} must be a non-negative integer`);
    if (!(inputMultiplier > 0) || !(outputMultiplier > 0)) throw new Error(`Large-context multipliers for ${record.provider}/${record.model} must be positive`);
  }
  return record;
}

export type PriceQuery = {
  provider: string;
  model: string;
  /** ISO date to price at. Defaults to today — quoting is a present-tense act unless told otherwise. */
  asOf?: string;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function covers(record: PriceRecord, date: string): boolean {
  return record.effectiveFrom <= date && (record.effectiveUntil === undefined || date < record.effectiveUntil);
}

/**
 * The ids a model can be priced under, most specific first.
 *
 * Providers publish rates against a family name (`claude-sonnet-5`, `gpt-4.1-mini`) but serve — and
 * `/v1/models` lists — dated snapshots of it (`claude-sonnet-5-20260514`, `gpt-4.1-mini-2025-04-14`)
 * and moving aliases (`…-latest`). Those are the same billed model at the same published rate, so
 * pricing only the exact string reports "unpriced" for the very ids the live model list hands the
 * user, and a run on a pinned snapshot goes unpriced while the identical unpinned one does not.
 *
 * Only version markers are stripped, and only from the end: a release date, `latest`, `preview`.
 * Each names a *version* of a model rather than a different model. Nothing else is trimmed — shortening
 * `gpt-5-mini` to `gpt-5` would price a cheap model at an expensive one's rate, which is the failure
 * this whole catalog exists to avoid.
 */
export function priceAliases(model: string): string[] {
  const aliases = [model];
  // `-YYYYMMDD` (Anthropic), `-YYYY-MM-DD` (OpenAI), or a `-latest`/`-preview` pointer at the same
  // model. Applied repeatedly so `claude-sonnet-5-latest` and a dated preview both reduce.
  let candidate = model;
  for (let step = 0; step < 3; step += 1) {
    const trimmed = candidate.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/i, "");
    if (trimmed === candidate || !trimmed) break;
    candidate = trimmed;
    aliases.push(candidate);
  }
  return aliases;
}

/**
 * The rate in force for one model on one date.
 *
 * Where two records overlap the later `effectiveFrom` wins, so a promotional rate layered over a
 * standing one resolves to the promotion without the standing entry having to be edited or removed.
 * Returning undefined is a real answer: an unpriced model must report "unknown", never zero.
 *
 * A dated snapshot falls back to its family's rate (see `priceAliases`), but only after an exact
 * match has been looked for — a snapshot that *is* priced separately keeps its own rate.
 */
export function selectPrice(records: readonly PriceRecord[], query: PriceQuery): PriceRecord | undefined {
  const date = query.asOf ?? today();
  for (const model of priceAliases(query.model)) {
    const match = records
      .filter((record) => record.provider === query.provider && record.model === model && covers(record, date))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    if (match) return match;
  }
  return undefined;
}

/**
 * When the selected rate stops applying — the one thing a cost report can warn about before it
 * silently starts quoting a stale number.
 */
export function priceExpiry(record: PriceRecord): string | undefined {
  return record.effectiveUntil;
}

/** Adapts a token record to the shape the cost ledger already prices usage with. */
export function tokenPricesFor(record: PriceRecord): TokenPrices {
  if (record.billingUnit !== "tokens") throw new Error(`${record.provider}/${record.model} is billed per ${record.billingUnit}, not tokens`);
  const { input, output, cachedInput } = record.rates;
  if (input === undefined || output === undefined) throw new Error(`${record.provider}/${record.model} needs input and output rates`);
  // `tokenPrices` takes per-million rates; scale when a record quotes a different denominator so a
  // provider that publishes per-thousand is still recorded in its own units.
  const scale = 1_000_000 / record.per;
  return tokenPrices(record.currency, input * scale, output * scale, cachedInput === undefined ? undefined : cachedInput * scale, record.largeContext);
}

/** Convenience for the common path: look up a model and get prices the ledger can use. */
export function tokenPricesAt(records: readonly PriceRecord[], query: PriceQuery): TokenPrices | undefined {
  const record = selectPrice(records, query);
  return record && record.billingUnit === "tokens" ? tokenPricesFor(record) : undefined;
}

export function definePrices(records: readonly PriceRecord[]): readonly PriceRecord[] {
  return records.map(validatePriceRecord);
}

/**
 * What a metered consumption cost, for anything not billed in tokens.
 *
 * `quantities` names how much of each meter was used — for one Exa search returning ten pages of
 * highlights, `{ request: 1, contents: 10 }`. Both meters are charged, on the same denominator,
 * which is exactly the part a single "per search" figure gets wrong: at typical result counts the
 * contents component is the larger half of the bill.
 *
 * An unknown meter is an error rather than a zero. Silently charging nothing for a meter the caller
 * believed it was recording is how a total ends up under the invoice with nothing to show for it.
 */
export function priceUnits(record: PriceRecord, quantities: Readonly<Record<string, number>>): Money {
  let units = 0;
  for (const [meter, quantity] of Object.entries(quantities)) {
    const rate = record.rates[meter];
    if (rate === undefined) throw new Error(`${record.provider}/${record.model} has no rate for meter "${meter}"`);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`Quantity for "${meter}" must be a non-negative number`);
    units += (quantity * rate) / record.per;
  }
  return money(units * 1_000_000, record.currency);
}
