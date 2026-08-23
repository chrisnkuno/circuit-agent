/**
 * Exa client — `/search` and `/contents`.
 *
 * Kept fetch-based (no SDK) so Convex actions and unit tests stay free of a heavyweight dependency
 * and every request option is explicit. Explicit matters more here than usual: Exa's own docs keep a
 * list of parameters that language models habitually invent (`useAutoprompt`, `livecrawl: "always"`,
 * `numSentences`, `highlightsPerUrl`, `tokensNum`, top-level `text` on `/search`), all of which are
 * deprecated or nonexistent. Nothing in this file can emit one, because the request body is built
 * field by field from a typed request rather than spread from caller-supplied objects.
 *
 * The one asymmetry worth remembering: on `/search`, `text`/`highlights`/`summary` are nested under
 * `contents`; on `/contents` the very same fields are top-level. That is Exa's shape, not a mistake
 * here, and `contentsBody` below is shared between the two so the nesting is decided in one place.
 *
 * Docs: https://exa.ai/docs/reference/search — index at https://exa.ai/docs/llms.txt
 */

/**
 * How hard Exa works on a query.
 *
 * The deep variants are not "the same search, slower": they plan multiple sub-searches, reason over
 * what comes back, and synthesize an answer, which is why they alone honour `additionalQueries` and
 * why an `outputSchema` is worth attaching to them. Latency is the reason this is a caller's choice
 * rather than always-the-best: `instant` answers in ~250ms and `deep-reasoning` can take 40s, so the
 * right pick depends on whether a person is waiting on the result or an agent is researching.
 */
export type ExaSearchType =
  "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";

export type ExaCategory =
  | "company"
  | "people"
  | "publication"
  | "news"
  | "personal site"
  | "financial report";

/** Documented ballpark upper latency per type, in ms — the basis for the per-request timeout. */
const LATENCY_CEILING: Record<ExaSearchType, number> = {
  instant: 5_000,
  fast: 10_000,
  auto: 20_000,
  "deep-lite": 45_000,
  deep: 90_000,
  "deep-reasoning": 180_000,
};

export type ExaSearchHit = {
  title: string;
  url: string;
  publishedDate: string | null;
  author: string | null;
  highlights: string[];
  /** Present only when `text` was requested; full page content as markdown. */
  text?: string | null;
};

/** A field-level citation from a synthesized answer. Exa returns these; never ask a schema for them. */
export type ExaGrounding = {
  field: string;
  citations: Array<{ url: string; title: string | null }>;
  confidence: "low" | "medium" | "high" | null;
};

export type ExaContentsRequest = {
  /**
   * Highlights are the default and the right one for an agent loop: they are extractive excerpts
   * chosen against the query, roughly a tenth of the tokens of full text, and they cost the same
   * latency. `true` is deliberately not the same as `{}` — Exa documents the bare boolean as the
   * highest-quality setting, and supplying an object with a `maxCharacters` cap actively lowers
   * result quality. So a cap is only ever sent when a caller asks for one.
   */
  highlights?: boolean | { query?: string; maxCharacters?: number };
  /** Full page text. Worth the tokens when the task is to understand a page, not to answer from it. */
  text?: boolean | { maxCharacters?: number };
  /**
   * Cache freshness. Omitted by default, which means "livecrawl only if there is no cached copy" —
   * the fastest correct behaviour. `0` forces a live crawl of every result and is the setting that
   * matters for security advisories, where a day-old cache is a wrong answer rather than a stale one.
   * `-1` is cache-only.
   */
  maxAgeHours?: number;
  livecrawlTimeoutMs?: number;
  subpages?: number;
  subpageTarget?: string[];
};

export type ExaSearchRequest = {
  query: string;
  numResults?: number;
  type?: ExaSearchType;
  category?: ExaCategory;
  /** Domain, path prefix (`exa.ai/blog`) or subdomain wildcard (`*.substack.com`). Max 1200. */
  includeDomains?: string[];
  excludeDomains?: string[];
  /** ISO 8601. Unsupported by the `company` and `people` categories, which reject them with a 400. */
  startPublishedDate?: string;
  endPublishedDate?: string;
  contents?: ExaContentsRequest;
  /** Steers *behaviour* — "prefer official sources". Shape belongs in `outputSchema`. */
  systemPrompt?: string;
  /** Steers *shape*. Works on every type, not only the deep ones; adds synthesis latency. */
  outputSchema?: Record<string, unknown>;
  /** Extra query variations the deep variants plan against. */
  additionalQueries?: string[];
  userLocation?: string;
  /** Overrides the latency-derived default; use when a caller has its own deadline. */
  timeoutMs?: number;
};

export type ExaSearchResponse = {
  requestId: string | null;
  /** Which type Exa actually ran — meaningful when `auto` was requested. */
  searchType: string | null;
  results: ExaSearchHit[];
  /** Synthesized answer, present when `outputSchema` was supplied. */
  output: {
    content: string | Record<string, unknown> | null;
    grounding: ExaGrounding[];
  } | null;
  /**
   * What Exa says this call cost, in USD.
   *
   * Exa's endpoint-provided estimated cost breakdown. It is better evidence than applying a
   * guessed page count to a catalog rate, but it is not an invoice; Exa bills from its usage
   * counters and those remain the accounting authority.
   */
  costDollars: number | null;
};

export type ExaContentsResponse = {
  requestId: string | null;
  results: ExaSearchHit[];
  /** Per-URL outcomes. Exa returns HTTP 200 even when individual URLs fail, so this must be read. */
  statuses: Array<{
    url: string;
    status: "success" | "error";
    errorTag: string | null;
  }>;
  costDollars: number | null;
};

export type ExaClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Fallback deadline for `/contents` and for search types with no ceiling of their own. */
  timeoutMs?: number;
};

type RawResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  text?: string;
};

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return value;
}

function domainList(
  value: string[] | undefined,
  name: string,
): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  // Exa's own cap. Sending more is a 400, and a 400 discovered at request time costs a whole
  // agent iteration to learn something that is knowable here.
  if (value.length > 1_200)
    throw new Error(`${name} accepts at most 1200 entries`);
  const cleaned = value.map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * The `text`/`highlights` half of a request body, shared by `/search` and `/contents`.
 *
 * Returns the fields unnested; the caller decides whether they go under `contents` (search) or at
 * the top level (contents). Defaulting to `highlights: true` when a caller asks for nothing is
 * deliberate — a search that returns titles and URLs with no excerpt makes the model fetch each
 * result to find out whether it was relevant, which costs far more than the highlights would have.
 */
function contentsBody(
  request: ExaContentsRequest | undefined,
): Record<string, unknown> {
  const contents = request ?? {};
  const body: Record<string, unknown> = {};

  const highlights = contents.highlights ?? (contents.text ? undefined : true);
  if (highlights === true) body.highlights = true;
  else if (highlights && typeof highlights === "object") {
    const shaped: Record<string, unknown> = {};
    if (highlights.query?.trim()) shaped.query = highlights.query.trim();
    const cap = boundedInteger(
      highlights.maxCharacters,
      100,
      100_000,
      "highlights.maxCharacters",
    );
    if (cap !== undefined) shaped.maxCharacters = cap;
    // An empty object would be a quality downgrade dressed as a request for defaults.
    body.highlights = Object.keys(shaped).length > 0 ? shaped : true;
  }

  if (contents.text === true) body.text = true;
  else if (contents.text && typeof contents.text === "object") {
    const cap = boundedInteger(
      contents.text.maxCharacters,
      100,
      1_000_000,
      "text.maxCharacters",
    );
    body.text = cap === undefined ? true : { maxCharacters: cap };
  }

  if (contents.maxAgeHours !== undefined) {
    if (!Number.isInteger(contents.maxAgeHours) || contents.maxAgeHours < -1)
      throw new Error("maxAgeHours must be -1, 0, or a positive integer");
    body.maxAgeHours = contents.maxAgeHours;
  }
  const livecrawl = boundedInteger(
    contents.livecrawlTimeoutMs,
    0,
    90_000,
    "livecrawlTimeoutMs",
  );
  if (livecrawl !== undefined) body.livecrawlTimeout = livecrawl;
  const subpages = boundedInteger(contents.subpages, 0, 100, "subpages");
  if (subpages !== undefined) body.subpages = subpages;
  const targets = contents.subpageTarget
    ?.map((entry) => entry.trim())
    .filter(Boolean);
  if (targets && targets.length > 0) body.subpageTarget = targets;

  return body;
}

function toHit(result: RawResult): ExaSearchHit {
  return {
    title: (result.title ?? result.url!).trim(),
    url: result.url!,
    publishedDate: result.publishedDate ?? null,
    author: result.author ?? null,
    highlights: (result.highlights ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
    text:
      typeof result.text === "string" && result.text.length > 0
        ? result.text
        : null,
  };
}

function toHits(results: RawResult[] | undefined): ExaSearchHit[] {
  return (results ?? [])
    .filter((result) => typeof result.url === "string" && result.url.length > 0)
    .map(toHit);
}

export class ExaSearchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ExaClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("EXA_API_KEY is required");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        // The status is the actionable half — 401 is a key problem, 429 is a pacing problem, 422 is
        // a request the caller can fix — so it leads, ahead of a body that may be an HTML error page.
        throw new Error(
          `Exa ${path} failed (${response.status}): ${text.slice(0, 240)}`,
        );
      }
      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(request: ExaSearchRequest): Promise<ExaSearchResponse> {
    const query = request.query.trim();
    if (!query) throw new Error("Exa query is required");
    const type = request.type ?? "auto";
    if (!(type in LATENCY_CEILING))
      throw new Error(`Unknown Exa search type: ${type}`);
    // 100 is Exa's ceiling. The old client capped at 10, which silently made a research request for
    // 40 sources into a request for 10 and reported success.
    const numResults = boundedInteger(request.numResults, 1, 100, "numResults");

    const body: Record<string, unknown> = { query, type };
    if (numResults !== undefined) body.numResults = numResults;
    if (request.category) body.category = request.category;
    const include = domainList(request.includeDomains, "includeDomains");
    if (include) body.includeDomains = include;
    const exclude = domainList(request.excludeDomains, "excludeDomains");
    if (exclude) body.excludeDomains = exclude;
    if (request.startPublishedDate)
      body.startPublishedDate = request.startPublishedDate;
    if (request.endPublishedDate)
      body.endPublishedDate = request.endPublishedDate;
    if (request.userLocation) body.userLocation = request.userLocation;
    if (request.systemPrompt?.trim())
      body.systemPrompt = request.systemPrompt.trim();
    if (request.outputSchema) body.outputSchema = request.outputSchema;
    const extraQueries = request.additionalQueries
      ?.map((entry) => entry.trim())
      .filter(Boolean);
    if (extraQueries && extraQueries.length > 0)
      body.additionalQueries = extraQueries;
    // Category filters that Exa rejects outright rather than ignoring. Caught here so the model gets
    // a sentence it can act on instead of a 400 it has to interpret.
    if (
      (request.category === "company" || request.category === "people") &&
      (exclude || request.startPublishedDate || request.endPublishedDate)
    ) {
      throw new Error(
        `The ${request.category} category does not support excludeDomains or date filters`,
      );
    }
    body.contents = contentsBody(request.contents);

    // Synthesis and forced livecrawls stack on top of the base type's latency, so the deadline has
    // to account for both or a correct deep search gets aborted for being slow as designed.
    const synthesis = request.outputSchema ? 20_000 : 0;
    const livecrawl = request.contents?.maxAgeHours === 0 ? 15_000 : 0;
    const timeoutMs =
      request.timeoutMs ?? LATENCY_CEILING[type] + synthesis + livecrawl;

    const payload = await this.post("/search", body, timeoutMs);
    const output = payload.output as
      { content?: unknown; grounding?: unknown[] } | undefined;
    return {
      requestId: (payload.requestId as string | undefined) ?? null,
      searchType: (payload.searchType as string | undefined) ?? null,
      results: toHits(payload.results as RawResult[] | undefined),
      output: output
        ? {
            content:
              (output.content as
                string | Record<string, unknown> | undefined) ?? null,
            grounding: (
              (output.grounding ?? []) as Array<Record<string, unknown>>
            ).map((entry) => ({
              field: (entry.field as string | undefined) ?? "content",
              citations: (
                (entry.citations ?? []) as Array<{
                  url?: string;
                  title?: string;
                }>
              )
                .filter((citation) => typeof citation.url === "string")
                .map((citation) => ({
                  url: citation.url!,
                  title: citation.title ?? null,
                })),
              confidence:
                (entry.confidence as ExaGrounding["confidence"] | undefined) ??
                null,
            })),
          }
        : null,
      costDollars:
        (payload.costDollars as { total?: number } | undefined)?.total ?? null,
    };
  }

  /**
   * Extracts clean content from URLs Exa already knows how to render — JavaScript pages and PDFs
   * included, which a plain `fetch` plus tag-stripping cannot do at all.
   */
  async contents(
    urls: readonly string[],
    request: ExaContentsRequest = {},
  ): Promise<ExaContentsResponse> {
    const cleaned = urls.map((url) => url.trim()).filter(Boolean);
    if (cleaned.length === 0) throw new Error("At least one URL is required");
    for (const url of cleaned)
      if (!/^https?:\/\//i.test(url))
        throw new Error(`Not an http(s) URL: ${url}`);

    // Top-level here, not nested under `contents` — the documented difference between the two
    // endpoints, and the single most common way this integration is written wrong.
    const body: Record<string, unknown> = {
      urls: cleaned,
      ...contentsBody(request),
    };
    const timeoutMs = this.timeoutMs + (request.maxAgeHours === 0 ? 15_000 : 0);
    const payload = await this.post("/contents", body, timeoutMs);

    return {
      requestId: (payload.requestId as string | undefined) ?? null,
      results: toHits(payload.results as RawResult[] | undefined),
      statuses: (
        (payload.statuses ?? []) as Array<{
          id?: string;
          status?: string;
          error?: { tag?: string };
        }>
      )
        .filter((status) => typeof status.id === "string")
        .map((status) => ({
          url: status.id!,
          status: status.status === "error" ? "error" : "success",
          errorTag: status.error?.tag ?? null,
        })),
      costDollars:
        (payload.costDollars as { total?: number } | undefined)?.total ?? null,
    };
  }
}

export function createExaClient(
  environment: { EXA_API_KEY?: string; EXA_BASE_URL?: string },
  fetchImpl?: typeof fetch,
): ExaSearchClient | undefined {
  const apiKey = environment.EXA_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new ExaSearchClient({
    apiKey,
    baseUrl: environment.EXA_BASE_URL?.trim() || undefined,
    fetchImpl,
  });
}
