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

const CIRCUITNOTION_SOURCE = "platform.circuitnotion.com live catalog (GET /v1/models, recorded 2026-08-23)";
const CIRCUITNOTION_VERIFIED = "2026-08-23";

const circuitNotionTokens = (model: string, input: number, output: number, cachedInput?: number) =>
  tokens("circuitnotion", model, "RWF", input, output, cachedInput, CIRCUITNOTION_SOURCE, CIRCUITNOTION_VERIFIED);

const GPT_56_LARGE_CONTEXT = { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } as const;
const circuitNotionGpt56 = (model: string, input: number, output: number): PriceRecord => ({
  ...circuitNotionTokens(model, input, output),
  largeContext: GPT_56_LARGE_CONTEXT,
});

/**
 * CircuitNotion's own catalog: not one model family but a menu CircuitNotion prices and bills in
 * RWF, spanning several underlying model generations — the OpenAI-named entries and the DeepSeek
 * entries are exactly as real for `CIRCUITNOTION_MODEL` as the `gpt-5.6-*` house names are. This
 * table is the authoritative source for this build. It mirrors the live `/v1/models` catalog, while
 * keeping every routed model under the `circuitnotion` provider because that is the account that
 * bills the CLI. The upstream-provider label in the web catalog describes routing, not who invoices
 * this request. The page does not publish cache-read rates, so none are invented here.
 */
const CIRCUITNOTION: PriceRecord[] = [
  // CircuitNotion routes.
  ...["auto", "circuit-1", "circuit-1-mini", "circuit-2-turbo"].map((model) => circuitNotionTokens(model, 304.18, 608.35)),
  ...["circuit-2", "circuit-3"].map((model) => circuitNotionTokens(model, 945.11, 1_890.23)),

  // GPT-5.6. The live catalog additionally applies 2x input and 1.5x output to requests whose
  // input exceeds 272,000 tokens; the base rates remain the values displayed in model lists.
  circuitNotionGpt56("gpt-5.6", 12_166.98, 73_001.88),
  circuitNotionGpt56("gpt-5.6-sol", 12_166.98, 73_001.88),
  circuitNotionGpt56("gpt-5.6-terra", 6_083.49, 36_500.94),
  circuitNotionGpt56("gpt-5.6-luna", 2_433.4, 14_600.38),

  // GPT-5.x
  circuitNotionTokens("gpt-5.5", 12_166.98, 73_001.88),
  circuitNotionTokens("gpt-5.5-pro", 73_001.88, 438_011.28),
  circuitNotionTokens("gpt-5.4", 6_083.49, 36_500.94),
  circuitNotionTokens("gpt-5.4-mini", 1_825.04, 10_950.28),
  circuitNotionTokens("gpt-5.4-nano", 486.68, 3_041.75),
  circuitNotionTokens("gpt-5.4-pro", 73_001.88, 438_011.28),
  circuitNotionTokens("gpt-5", 3_041.75, 24_333.96),
  circuitNotionTokens("gpt-5-mini", 608.36, 4_866.79),
  circuitNotionTokens("gpt-5-nano", 121.67, 973.36),

  // GPT-4.x
  circuitNotionTokens("gpt-4.1", 4_345.35, 17_381.4),
  circuitNotionTokens("gpt-4.1-mini", 869.08, 3_476.28),
  circuitNotionTokens("gpt-4.1-nano", 217.26, 869.08),
  circuitNotionTokens("gpt-4o", 5_431.69, 21_726.75),
  circuitNotionTokens("gpt-4o-mini", 325.9, 1_303.6),

  // Reasoning
  circuitNotionTokens("o4-mini", 2_676.73, 10_706.95),
  circuitNotionTokens("o3", 4_866.79, 19_467.17),
  circuitNotionTokens("o3-mini", 2_676.73, 10_706.95),
  circuitNotionTokens("o3-pro", 48_667.92, 194_671.68),

  // DeepSeek
  circuitNotionTokens("deepseek-v4-flash", 304.18, 608.35),
  circuitNotionTokens("deepseek-v4-pro", 945.11, 1_890.23),

  // Moonshot.
  ...["kimi", "kimi-k3"].map((model) => circuitNotionTokens(model, 6_518.03, 32_590.13)),
  ...["kimi-k2.7-code", "kimi-k2.6", "kimi-k2"].map((model) => circuitNotionTokens(model, 2_064.04, 8_690.7)),
  circuitNotionTokens("kimi-k2.7-code-highspeed", 4_128.09, 17_381.4),
  circuitNotionTokens("kimi-k2.5", 1_303.6, 6_518.03),

  // Anthropic models routed and billed by CircuitNotion.
  ...["claude", "claude-sonnet-5"].map((model) => circuitNotionTokens(model, 4_345.35, 21_726.75)),
  ...["claude-fable-5", "claude-mythos-5"].map((model) => circuitNotionTokens(model, 21_726.75, 108_633.75)),
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"].map((model) => circuitNotionTokens(model, 12_166.98, 60_834.9)),
  circuitNotionTokens("claude-haiku-4-5", 2_172.68, 10_863.38),
  ...["claude-sonnet-4-6", "claude-sonnet-4-5"].map((model) => circuitNotionTokens(model, 6_518.03, 32_590.13)),

  // Embeddings — input tokens only, via POST /v1/embeddings. Default output dimensions noted for
  // reference (small: 1536, large: 3072, ada-002: 1536); dimensionality isn't a priced quantity so
  // it has no field on `PriceRecord`, but a caller reconciling this against the CircuitNotion
  // console needs it to confirm they are reading the same row.
  {
    provider: "circuitnotion", model: "text-embedding-3-small", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 43.45 },
    source: `${CIRCUITNOTION_SOURCE} — 1536 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "text-embedding-3-large", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 282.45 },
    source: `${CIRCUITNOTION_SOURCE} — 3072 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "text-embedding-ada-002", modality: "embedding", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { input: 217.27 },
    source: `${CIRCUITNOTION_SOURCE} — 1536 default dimensions`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },

  // Image generation — two different billing shapes under one modality. The GPT Image family bills
  // like a text model, by output tokens; DALL-E bills a flat rate per image at the reference
  // (1024×1024) size, which is why its `per` is 1 rather than a million.
  {
    provider: "circuitnotion", model: "gpt-image-2", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 65_180.25 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "gpt-image-1.5", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 69_525.6 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "gpt-image-1-mini", modality: "image", currency: "RWF",
    billingUnit: "tokens", per: 1_000_000, rates: { output: 17_381.4 },
    source: CIRCUITNOTION_SOURCE, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "dall-e-3", modality: "image", currency: "RWF",
    billingUnit: "images", per: 1, rates: { image: 86.91 },
    source: `${CIRCUITNOTION_SOURCE} — reference rate at 1024×1024`, effectiveFrom: CIRCUITNOTION_VERIFIED,
  },
  {
    provider: "circuitnotion", model: "dall-e-2", modality: "image", currency: "RWF",
    billingUnit: "images", per: 1, rates: { image: 43.45 },
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
