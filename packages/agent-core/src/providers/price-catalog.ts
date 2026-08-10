import { definePrices, type PriceRecord } from "../pricing";

/**
 * The published rates this build knows, in the currency each provider actually quotes.
 *
 * Recorded in the provider's own currency and denominator rather than pre-converted to RWF, because
 * a table denominated in a currency nobody publishes is a table nobody can check against an invoice.
 * Conversion happens at display time, against a dated FX rate that travels with the quote.
 *
 * `effectiveFrom` is the earliest date this build can attest the rate applied — the date the entry
 * was verified against the provider's price page, not a claim about when the provider introduced it.
 * That is the conservative reading: it never causes a historical cost to be re-priced at a rate that
 * had not been confirmed yet.
 *
 * A model absent from here still runs. It reports "unpriced" rather than being quietly assigned a
 * neighbour's rate, because a confidently wrong cost is worse than an admitted unknown.
 */

const ANTHROPIC_VERIFIED = "2026-06-24";
const ANTHROPIC_SOURCE = "anthropic.com/pricing, recorded 2026-06-24";

/**
 * Anthropic list prices, USD per million tokens.
 *
 * Cached input is a tenth of the input rate throughout — the published cache-read multiplier — and
 * it is what makes a long agent session affordable. Recording it is the difference between a cost
 * report that shows the saving and one that overstates a cached session by roughly ten times.
 */
const ANTHROPIC: PriceRecord[] = [
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"].map((model) => tokens("anthropic", model, "USD", 5, 25, 0.5, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED)),
  tokens("anthropic", "claude-fable-5", "USD", 10, 50, 1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-sonnet-4-6", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-haiku-4-5", "USD", 1, 5, 0.1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),

  // Sonnet 5 is the reason this catalog is dated rather than constant. It runs on an introductory
  // rate that ends 2026-08-31; both rates are true, on different days, and a single hardcoded
  // number would be wrong on one side of that boundary with nothing to signal which side.
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 2, 10, 0.2, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveUntil: "2026-09-01", source: `${ANTHROPIC_SOURCE} (introductory rate through 2026-08-31)` },
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveFrom: "2026-09-01", source: `${ANTHROPIC_SOURCE} (standard rate from 2026-09-01)` },
];

/** Builds a text-token `PriceRecord` at the provider's own per-million rate. */
function tokens(provider: string, model: string, currency: string, input: number, output: number, cachedInput: number | undefined, source: string, effectiveFrom: string): PriceRecord {
  return {
    provider,
    model,
    modality: "text",
    currency,
    billingUnit: "tokens",
    per: 1_000_000,
    rates: { input, output, ...(cachedInput === undefined ? {} : { cachedInput }) },
    source,
    effectiveFrom,
  };
}

const CIRCUITNOTION_SOURCE = "CircuitNotion pricing catalog (user-supplied RWF rate card, recorded 2026-08-10)";
const CIRCUITNOTION_VERIFIED = "2026-08-10";

const circuitNotionTokens = (model: string, input: number, output: number, cachedInput: number) =>
  tokens("circuitnotion", model, "RWF", input, output, cachedInput, CIRCUITNOTION_SOURCE, CIRCUITNOTION_VERIFIED);

/**
 * CircuitNotion's own catalog: not one model family but a menu CircuitNotion prices and bills in
 * RWF, spanning several underlying model generations — the OpenAI-named entries and the DeepSeek
 * entries are exactly as real for `CIRCUITNOTION_MODEL` as the `gpt-5.6-*` house names are. This
 * table is the authoritative source for this build: CircuitNotion does not publish a complete public
 * price page (see the gap register), so these rates come from the operator directly rather than a
 * scraped page — the same trust level as an invoice.
 */
const CIRCUITNOTION: PriceRecord[] = [
  // GPT-5.6 — CircuitNotion's own frontier tier, house-named.
  circuitNotionTokens("gpt-5.6", 8_050, 48_300, 805),
  circuitNotionTokens("gpt-5.6-sol", 8_050, 48_300, 805),
  circuitNotionTokens("gpt-5.6-terra", 4_025, 24_150, 402.5),
  circuitNotionTokens("gpt-5.6-luna", 1_610, 9_660, 161), // the provider default (PROVIDERS.circuitnotion.defaultModel)

  // GPT-5.x
  circuitNotionTokens("gpt-5.5", 8_050, 48_300, 805),
  circuitNotionTokens("gpt-5.5-pro", 48_300, 289_800, 48_300),
  circuitNotionTokens("gpt-5.4", 4_025, 24_150, 402.5),
  circuitNotionTokens("gpt-5.4-mini", 1_207.5, 7_245, 120.75),
  circuitNotionTokens("gpt-5.4-nano", 322, 2_012.5, 32.20),
  circuitNotionTokens("gpt-5.4-pro", 48_300, 289_800, 48_300),
  circuitNotionTokens("gpt-5", 2_012.5, 16_100, 201.25),
  circuitNotionTokens("gpt-5-mini", 402.5, 3_220, 40.25),
  circuitNotionTokens("gpt-5-nano", 80.50, 644, 40.25),

  // GPT-4.x
  circuitNotionTokens("gpt-4.1", 3_220, 12_880, 805),
  circuitNotionTokens("gpt-4.1-mini", 644, 2_576, 161),
  circuitNotionTokens("gpt-4.1-nano", 161, 644, 40.25),
  circuitNotionTokens("gpt-4o", 4_025, 16_100, 2_012.5),
  circuitNotionTokens("gpt-4o-mini", 241.5, 966, 120.75),

  // Reasoning
  circuitNotionTokens("o4-mini", 1_771, 7_084, 442.75),
  circuitNotionTokens("o3", 3_220, 12_880, 805),
  circuitNotionTokens("o3-mini", 1_771, 7_084, 885.5),
  circuitNotionTokens("o3-pro", 32_200, 128_800, 32_200),

  // DeepSeek
  circuitNotionTokens("deepseek-v4-flash", 225.4, 450.8, 4.51),
  circuitNotionTokens("deepseek-v4-pro", 700.35, 1_400.7, 5.84),

  // Embeddings — input tokens only, via POST /v1/embeddings. Default output dimensions noted for
  // reference (small: 1536, large: 3072, ada-002: 1536); dimensionality isn't a priced quantity so
  // it has no field on `PriceRecord`, but a caller reconciling this against the CircuitNotion
  // console needs it to confirm they are reading the same row.
  {
    provider: "circuitnotion", model: "text-embedding-3-small", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 32.20 },
    source: `${CIRCUITNOTION_SOURCE} — 1536 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "text-embedding-3-large", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 209.3 },
    source: `${CIRCUITNOTION_SOURCE} — 3072 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "text-embedding-ada-002", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 161 },
    source: `${CIRCUITNOTION_SOURCE} — 1536 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },

  // Image generation — two different billing shapes under one modality. The GPT Image family bills
  // like a text model, by output tokens; DALL-E bills a flat rate per image at the reference
  // (1024×1024) size, which is why its `per` is 1 rather than a million.
  {
    provider: "circuitnotion", model: "gpt-image-2", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 48_300 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "gpt-image-1.5", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 51_520 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "gpt-image-1-mini", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 12_880 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "dall-e-3", modality: "image", currency: "RWF",
    billingUnit: "images", per: 1, rates: { image: 64.40 },
    source: `${CIRCUITNOTION_SOURCE} — reference rate at 1024×1024`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "dall-e-2", modality: "image", currency: "RWF",
    billingUnit: "images", per: 1, rates: { image: 32.20 },
    source: `${CIRCUITNOTION_SOURCE} — reference rate at 1024×1024`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
];

/**
 * Non-model meters.
 *
 * A task's cost is not only its tokens. Search, transcription and sandbox time are billed by other
 * providers on other denominators, and leaving them out does not make them free — it makes the
 * reported total quietly lower than the invoice, which is the one direction a cost report must
 * never be wrong in.
 */
const SERVICES: PriceRecord[] = [
  {
    provider: "exa",
    model: "search",
    modality: "search",
    currency: "USD",
    billingUnit: "requests",
    per: 1_000,
    // Two meters on one call: the search itself, and each page whose contents are returned. A
    // ten-result search with highlights is therefore ~$0.017, not the ~$0.007 the request price
    // alone suggests — the contents component is the larger half at typical result counts.
    rates: { request: 7, contents: 1 },
    source: "exa.ai/pricing (API tab)",
    effectiveFrom: "2026-08-10",
  },
];

export const PRICE_CATALOG: readonly PriceRecord[] = definePrices([...ANTHROPIC, ...CIRCUITNOTION, ...SERVICES]);

/**
 * Providers this build deliberately ships no rates for.
 *
 * OpenAI's catalog is not verified here — a wrong price is worse than an honest "unpriced". Its
 * costs report as unknown until a rate is configured through the price-override environment
 * variables. CircuitNotion is no longer in this list: its RWF rate card above is the authoritative
 * catalog input, supplied by the operator rather than scraped from an incomplete public page.
 */
export const UNPRICED_PROVIDERS: readonly string[] = ["openai"];
