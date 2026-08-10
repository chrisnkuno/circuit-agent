/**
 * Thin Exa Search client. Kept fetch-based (no SDK) so Convex actions and unit tests
 * stay free of a heavyweight dependency and every request option is explicit.
 *
 * Docs: https://exa.ai/docs/reference/search-api-guide
 */

export type ExaSearchHit = {
  title: string;
  url: string;
  publishedDate: string | null;
  author: string | null;
  highlights: string[];
};

export type ExaSearchRequest = {
  query: string;
  numResults: number;
  type: "auto" | "fast" | "instant";
  category?: "publication" | "news" | "company" | "personal site" | "financial report" | "people";
  /** Max characters of highlights per result — thrifty default for agent dossiers. */
  highlightMaxCharacters: number;
};

export type ExaSearchResponse = {
  requestId: string | null;
  results: ExaSearchHit[];
};

export type ExaClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

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
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async search(request: ExaSearchRequest): Promise<ExaSearchResponse> {
    if (!request.query.trim()) throw new Error("Exa query is required");
    if (!Number.isInteger(request.numResults) || request.numResults < 1 || request.numResults > 10) {
      throw new Error("numResults must be between 1 and 10");
    }
    if (!Number.isInteger(request.highlightMaxCharacters) || request.highlightMaxCharacters < 200 || request.highlightMaxCharacters > 4_000) {
      throw new Error("highlightMaxCharacters must be between 200 and 4000");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query: request.query.trim(),
          type: request.type,
          numResults: request.numResults,
          ...(request.category ? { category: request.category } : {}),
          // Highlights only — full text and AI summaries are deliberately omitted to keep Wander
          // evidence cheap. Note that "cheap" is not $0.007: the $7-per-1,000 request price is
          // only one of two meters, and contents are billed at $1 per 1,000 pages per content
          // type, so ten results cost ~$0.017 — the contents half being the larger one. The
          // ledger charges both; see `price-catalog.ts`.
          contents: {
            highlights: {
              maxCharacters: request.highlightMaxCharacters,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Exa search failed (${response.status}): ${body.slice(0, 240)}`);
      }
      const payload = (await response.json()) as {
        requestId?: string;
        results?: Array<{
          title?: string;
          url?: string;
          publishedDate?: string;
          author?: string;
          highlights?: string[];
        }>;
      };
      return {
        requestId: payload.requestId ?? null,
        results: (payload.results ?? [])
          .filter((result) => typeof result.url === "string" && result.url.length > 0)
          .map((result) => ({
            title: (result.title ?? result.url!).trim(),
            url: result.url!,
            publishedDate: result.publishedDate ?? null,
            author: result.author ?? null,
            highlights: (result.highlights ?? []).map((item) => item.trim()).filter(Boolean),
          })),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createExaClient(environment: { EXA_API_KEY?: string; EXA_BASE_URL?: string }, fetchImpl?: typeof fetch): ExaSearchClient | undefined {
  const apiKey = environment.EXA_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new ExaSearchClient({ apiKey, baseUrl: environment.EXA_BASE_URL?.trim() || undefined, fetchImpl });
}
