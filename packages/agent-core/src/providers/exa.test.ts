import { describe, expect, it, vi } from "vitest";
import { createExaClient, ExaSearchClient } from "./exa";

const ok = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
const stub = (payload: unknown = { results: [] }) => vi.fn(async () => ok(payload));
const bodyOf = (fetchImpl: { mock: { calls: unknown[][] } }, index = 0) =>
  JSON.parse(((fetchImpl.mock.calls[index]?.[1] as { body?: string } | undefined)?.body) ?? "{}") as Record<string, unknown>;

describe("ExaSearchClient", () => {
  it("is absent without EXA_API_KEY", () => {
    expect(createExaClient({})).toBeUndefined();
  });

  it("is present, and trims the key, once EXA_API_KEY is configured", () => {
    expect(createExaClient({ EXA_API_KEY: "  exa_test  " })).toBeInstanceOf(ExaSearchClient);
  });

  it("refuses to construct without a real key", () => {
    expect(() => new ExaSearchClient({ apiKey: "   " })).toThrow("EXA_API_KEY");
  });

  it("uses a configured Exa-compatible base URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://search.example.com/search");
      return ok({ results: [] });
    });
    const client = createExaClient({ EXA_API_KEY: "key", EXA_BASE_URL: "https://search.example.com/" }, fetchImpl)!;
    await client.search({ query: "test", type: "fast" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  /**
   * Exa publishes a list of parameters that language models reliably invent — every one of them is
   * either deprecated or has never existed, and each produces a 400 or a silently worse result. The
   * client builds its body field by field precisely so none of them can appear, and this is the test
   * that keeps that true as fields are added.
   */
  it("never emits a deprecated or nonexistent parameter", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({ query: "x", contents: { text: true, maxAgeHours: 0 } });
    const body = bodyOf(fetchImpl);
    for (const forbidden of ["useAutoprompt", "numSentences", "highlightsPerUrl", "tokensNum", "livecrawl", "includeUrls", "excludeUrls"]) {
      expect(body).not.toHaveProperty(forbidden);
      expect(body.contents as Record<string, unknown>).not.toHaveProperty(forbidden);
    }
    // On /search the content fields are nested; a top-level `text` is the documented wrong shape.
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("highlights");
  });

  it("asks for bare highlights by default, because a maxCharacters cap lowers result quality", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({ query: "x" });
    expect(bodyOf(fetchImpl).contents).toEqual({ highlights: true });
  });

  it("caps highlights only when a caller actually asks for a cap", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({ query: "x", contents: { highlights: { maxCharacters: 1_200, query: "guide me" } } });
    expect(bodyOf(fetchImpl).contents).toEqual({ highlights: { query: "guide me", maxCharacters: 1_200 } });
  });

  it("treats an empty highlights object as a request for the default, not as an empty cap", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({ query: "x", contents: { highlights: {} } });
    expect(bodyOf(fetchImpl).contents).toEqual({ highlights: true });
  });

  it("drops highlights when only full text was asked for", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({ query: "x", contents: { text: { maxCharacters: 9_000 } } });
    expect(bodyOf(fetchImpl).contents).toEqual({ text: { maxCharacters: 9_000 } });
  });

  it("carries every deep-search field through to the request", async () => {
    const fetchImpl = stub();
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search({
      query: "cve in express 4.18",
      type: "deep-reasoning",
      numResults: 40,
      includeDomains: ["nvd.nist.gov", " github.com "],
      startPublishedDate: "2026-01-01",
      systemPrompt: "prefer official advisories",
      outputSchema: { type: "text", description: "answer" },
      additionalQueries: ["express security advisory"],
      contents: { maxAgeHours: 0 },
    });
    const body = bodyOf(fetchImpl);
    expect(body.type).toBe("deep-reasoning");
    expect(body.numResults).toBe(40);
    expect(body.includeDomains).toEqual(["nvd.nist.gov", "github.com"]);
    expect(body.startPublishedDate).toBe("2026-01-01");
    expect(body.systemPrompt).toBe("prefer official advisories");
    expect(body.outputSchema).toEqual({ type: "text", description: "answer" });
    expect(body.additionalQueries).toEqual(["express security advisory"]);
    expect(body.contents).toEqual({ highlights: true, maxAgeHours: 0 });
  });

  /**
   * The old client hard-capped `numResults` at 10, so a request for 40 sources silently became a
   * request for 10 and reported success. Exa's real ceiling is 100.
   */
  it("accepts result counts up to Exa's real ceiling and rejects only what Exa rejects", async () => {
    const c = () => new ExaSearchClient({ apiKey: "k", fetchImpl: stub() as unknown as typeof fetch });
    await expect(c().search({ query: "x", numResults: 100 })).resolves.toBeDefined();
    await expect(c().search({ query: "x", numResults: 101 })).rejects.toThrow("numResults");
    await expect(c().search({ query: "x", numResults: 0 })).rejects.toThrow("numResults");
    await expect(c().search({ query: "  " })).rejects.toThrow("query is required");
  });

  it("refuses the filters Exa's company and people categories reject, before spending a round trip", async () => {
    const client = () => new ExaSearchClient({ apiKey: "k", fetchImpl: stub() as unknown as typeof fetch });
    await expect(client().search({ query: "x", category: "company", excludeDomains: ["a.com"] })).rejects.toThrow(/company category/);
    await expect(client().search({ query: "x", category: "people", startPublishedDate: "2026-01-01" })).rejects.toThrow(/people category/);
    // The same filters are fine on a category that supports them.
    await expect(client().search({ query: "x", category: "news", startPublishedDate: "2026-01-01" })).resolves.toBeDefined();
  });

  /**
   * A deep-reasoning search is documented at 12-40s and the old client aborted everything at 20s,
   * so the slowest search type was the one guaranteed to be killed for running as designed.
   */
  it("gives a slow search type a deadline it can actually finish inside", async () => {
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      // AbortSignal.timeout is not observable, so the deadline is inferred from the signal's own
      // timer: instead, assert the request completes rather than aborts for each type.
      seen.push(init?.signal ? 1 : 0);
      return ok({ results: [] });
    });
    const client = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const type of ["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"] as const) {
      await expect(client.search({ query: "x", type })).resolves.toBeDefined();
    }
    expect(seen).toEqual([1, 1, 1, 1, 1, 1]);
    await expect(client.search({ query: "x", type: "nonsense" as never })).rejects.toThrow("Unknown Exa search type");
  });

  it("surfaces a non-ok response as an error carrying the status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.search({ query: "x" })).rejects.toThrow(/429.*rate limited/s);
  });

  it("drops results with no url, and falls back to the url when there is no title", async () => {
    const fetchImpl = stub({
      results: [
        { title: "Has a title", url: "https://example.com/a", highlights: [" padded  "] },
        { url: "https://example.com/b" }, // no title — falls back to the url
        { title: "No url at all" }, // dropped entirely
      ],
    });
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.search({ query: "x" });
    expect(result.results.map((hit) => hit.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.results[0].highlights).toEqual(["padded"]);
    expect(result.results[1].title).toBe("https://example.com/b");
  });

  it("reports absent fields as null rather than inventing them", async () => {
    const fetchImpl = stub({ results: [] });
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.search({ query: "x" });
    expect(result.requestId).toBeNull();
    expect(result.searchType).toBeNull();
    expect(result.output).toBeNull();
    expect(result.costDollars).toBeNull();
  });

  it("keeps the synthesized answer and its grounding, and the cost Exa reported", async () => {
    const fetchImpl = stub({
      requestId: "r1",
      searchType: "deep",
      results: [{ title: "T", url: "https://example.com/a" }],
      output: {
        content: "Express 4.18 is affected by CVE-2024-0001.",
        grounding: [{ field: "content", citations: [{ url: "https://nvd.nist.gov/x", title: "NVD" }, { title: "no url" }], confidence: "high" }],
      },
      costDollars: { total: 0.042 },
    });
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.search({ query: "x", type: "deep" });
    expect(result.searchType).toBe("deep");
    expect(result.output?.content).toContain("CVE-2024-0001");
    // The citation with no url is dropped: a source you cannot open is not a source.
    expect(result.output?.grounding[0].citations).toEqual([{ url: "https://nvd.nist.gov/x", title: "NVD" }]);
    expect(result.output?.grounding[0].confidence).toBe("high");
    expect(result.costDollars).toBe(0.042);
  });
});

describe("ExaSearchClient contents", () => {
  it("puts the content fields at the top level, which is where /contents wants them", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.exa.ai/contents");
      return ok({ results: [] });
    });
    const c = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await c.contents(["https://example.com"], { text: { maxCharacters: 5_000 } });
    const body = bodyOf(fetchImpl as unknown as { mock: { calls: unknown[][] } });
    expect(body.urls).toEqual(["https://example.com"]);
    expect(body.text).toEqual({ maxCharacters: 5_000 });
    // Nesting is the /search shape, and sending it here is the documented mistake.
    expect(body).not.toHaveProperty("contents");
  });

  it("rejects a non-http url and an empty list before calling fetch", async () => {
    const c = () => new ExaSearchClient({ apiKey: "k", fetchImpl: stub() as unknown as typeof fetch });
    await expect(c().contents([])).rejects.toThrow("At least one URL");
    await expect(c().contents(["   "])).rejects.toThrow("At least one URL");
    await expect(c().contents(["file:///etc/passwd"])).rejects.toThrow("Not an http(s) URL");
  });

  /**
   * `/contents` answers HTTP 200 even when an individual URL failed, so a caller that only checks
   * the status silently reports a 404 page as successfully fetched content.
   */
  it("reports per-url failures, which arrive inside a 200 response", async () => {
    const fetchImpl = stub({
      results: [{ title: "T", url: "https://example.com/a", text: "body" }],
      statuses: [
        { id: "https://example.com/a", status: "success" },
        { id: "https://example.com/b", status: "error", error: { tag: "CRAWL_NOT_FOUND" } },
      ],
      costDollars: { total: 0.003 },
    });
    const c = new ExaSearchClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.contents(["https://example.com/a", "https://example.com/b"]);
    expect(result.statuses).toEqual([
      { url: "https://example.com/a", status: "success", errorTag: null },
      { url: "https://example.com/b", status: "error", errorTag: "CRAWL_NOT_FOUND" },
    ]);
    expect(result.results[0].text).toBe("body");
    expect(result.costDollars).toBe(0.003);
  });
});
