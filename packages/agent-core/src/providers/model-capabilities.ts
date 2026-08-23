/**
 * What a model can actually hold and produce.
 *
 * Nova used to answer both questions with one constant each: a 200,000-token context limit and a
 * 16,000-token output ceiling, applied to every model on every provider. Both were wrong in both
 * directions at once. A current Opus or Sonnet holds a million tokens, so compaction fired at 140K
 * — a summarization round trip, and a lossy transcript, bought for nothing, five times earlier
 * than needed. And 16,000 output tokens is a quarter of what those models will write in one reply,
 * so long answers ended with `length` and had to be resumed, each resumption re-sending the whole
 * conversation to continue a sentence.
 *
 * The fix is not a bigger constant. It is asking the model.
 *
 * Two rules govern this table:
 *
 * **Unknown means conservative, never optimistic.** A model that is not listed gets exactly the
 * limits Nova used before this file existed. Guessing a large window for an unrecognised id turns
 * a clean local decision into a 400 from the provider halfway through someone's work.
 *
 * **Published numbers, dated, with the source named.** Every row below is a documented figure, not
 * a remembered one. Where a provider exposes capabilities over its API (Anthropic's `/v1/models`
 * returns `max_input_tokens` and `max_tokens`), that live answer is authoritative and this table is
 * the offline fallback — which is the right shape anyway, because the CLI must work on a plane.
 */

export type ModelCapabilities = {
  /** Total input the model accepts, in tokens. */
  contextWindow: number;
  /** Most tokens the model will produce in one reply, thinking included where it shares the budget. */
  maxOutputTokens: number;
  /**
   * Whether `output_config.effort` is accepted.
   *
   * Gated rather than always sent, because a model that does not know the field rejects the whole
   * request with a 400 — turning a spend optimization into an outage. False for anything
   * unrecognised, on the same principle as every other row here.
   */
  supportsEffort: boolean;
};

/**
 * What an unrecognised model is assumed to do: exactly what Nova assumed for everything before.
 *
 * Deliberately unchanged from the old hardcoded pair. An unknown model is not a reason to become
 * more adventurous with someone else's request.
 */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = { contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false };

/**
 * Known models, by exact id and by family prefix.
 *
 * Anthropic figures: current models documentation, cached 2026-06-24 — the Claude 5 family and the
 * 4.6+ Opus/Sonnet line hold 1M tokens and write up to 128K. Haiku 4.5 holds 200K.
 *
 * Longest prefix wins, so a dated or gateway-suffixed id (`claude-opus-5-20260101`, which some
 * OpenAI-compatible gateways serve even though Anthropic's own ids carry no date) resolves to its
 * family rather than falling through to the conservative default.
 */
type CapabilityEntry = { prefix: string; match: "prefix" | "exact"; capabilities: ModelCapabilities };

function exactCapabilities(models: readonly string[], contextWindow: number, maxOutputTokens: number, supportsEffort = false): CapabilityEntry[] {
  return models.map((prefix) => ({ prefix, match: "exact", capabilities: { contextWindow, maxOutputTokens, supportsEffort } }));
}

const KNOWN_CAPABILITIES: ReadonlyArray<CapabilityEntry> = [
  // CircuitNotion live catalog, GET /v1/models, recorded 2026-08-23. These are explicit model
  // contracts, not guesses about whichever upstream a route happens to select.
  ...exactCapabilities(["auto", "circuit-1", "circuit-1-mini", "circuit-2", "circuit-2-turbo", "circuit-3", "deepseek-v4-flash", "deepseek-v4-pro"], 1_000_000, 384_000),
  ...exactCapabilities(["kimi", "kimi-k3"], 1_048_576, 1_048_576),
  ...exactCapabilities(["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2", "kimi-k2.5"], 262_144, 32_768),

  { prefix: "claude-fable-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-mythos-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-8", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-7", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-6", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-sonnet-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-sonnet-4-6", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsEffort: true } },
  { prefix: "claude-sonnet-4-5", match: "prefix", capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: true } },
  { prefix: "claude-haiku-4-5", match: "prefix", capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: false } },
  { prefix: "claude", match: "exact", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  /**
   * OpenAI figures: developers.openai.com model pages, fetched 2026-08-22.
   *
   * Matched exactly, not by prefix, and that difference is deliberate. A dated Anthropic id is the
   * same model with a snapshot suffix, but `gpt-5.4-mini` is a *different* model from `gpt-5.4`
   * with its own limits — limits that were not obtainable from the published pages at the time of
   * writing. A prefix rule here would hand `mini` and `nano` the flagship's million-token window on
   * no evidence, which is exactly the optimism this table exists to avoid: they fall through to the
   * conservative default until someone verifies their real numbers.
   */
  ...exactCapabilities(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], 1_050_000, 128_000, true),
  ...exactCapabilities(["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro"], 1_050_000, 128_000),
  ...exactCapabilities(["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5", "gpt-5-mini", "gpt-5-nano"], 400_000, 128_000),
  ...exactCapabilities(["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"], 1_047_576, 32_768),
  ...exactCapabilities(["gpt-4o", "gpt-4o-mini"], 128_000, 16_384),
  ...exactCapabilities(["o4-mini", "o3", "o3-mini", "o3-pro"], 200_000, 100_000),
];

/**
 * The capabilities of a model id, or the conservative default.
 *
 * Case-insensitive, and tolerant of the `anthropic.` / `vertex/` style prefixes a hosting platform
 * puts in front of an otherwise-standard id — the model is the same model whoever is serving it.
 */
export function capabilitiesFor(modelId: string | undefined): ModelCapabilities {
  if (!modelId?.trim()) return CONSERVATIVE_CAPABILITIES;
  const normalized = modelId.trim().toLowerCase();
  const candidates = new Set([normalized]);
  // `some-gateway/claude-opus-5` and `anthropic.claude-opus-5` are that model being routed, not a
  // different model. Both spellings are reduced to the bare id before matching.
  const afterSlash = normalized.slice(normalized.lastIndexOf("/") + 1);
  candidates.add(afterSlash);
  const vendorIndex = afterSlash.indexOf("claude-");
  if (vendorIndex > 0) candidates.add(afterSlash.slice(vendorIndex));

  // Longest prefix wins: `claude-opus-4-8` must not be decided by a shorter `claude-opus-4` row.
  let best: { prefix: string; capabilities: ModelCapabilities } | undefined;
  for (const entry of KNOWN_CAPABILITIES) {
    const matches = [...candidates].some((candidate) => (entry.match === "exact" ? candidate === entry.prefix : candidate.startsWith(entry.prefix)));
    if (!matches) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.capabilities ?? CONSERVATIVE_CAPABILITIES;
}

/**
 * The output ceiling Nova asks for by default, whatever the model could theoretically produce.
 *
 * 64,000 rather than the model's full 128,000 for one reason: this number is also the reserve
 * subtracted from the context budget before compaction is considered, so asking for the maximum
 * permanently reserves an eighth of a 1M window against a reply that will almost never be that
 * long. 64K is past the point where a real answer gets truncated, and the runtime resumes a `length`
 * turn anyway if one ever is.
 *
 * Requests this large must stream — an unstreamed reply of this size will hit the SDK's HTTP
 * timeout before it finishes — which is why the providers stream unconditionally.
 */
export const DEFAULT_OUTPUT_CEILING = 64_000;

/**
 * The largest output any current model will produce, used where the model is not in scope.
 *
 * A protocol bound, not a policy one: request validators that never see a model id use this so
 * they reject the absurd without rejecting the merely large. What a *particular* model can do is
 * `capabilitiesFor(id).maxOutputTokens`, and that is always the tighter, truer answer.
 */
export const PROTOCOL_MAX_OUTPUT_TOKENS = 128_000;

/** The budget pair a session should run with, given what its model can do. */
export function budgetsFor(modelId: string | undefined): { contextLimit: number; maxOutputTokens: number } {
  const capabilities = capabilitiesFor(modelId);
  return {
    contextLimit: capabilities.contextWindow,
    maxOutputTokens: Math.min(capabilities.maxOutputTokens, DEFAULT_OUTPUT_CEILING),
  };
}
