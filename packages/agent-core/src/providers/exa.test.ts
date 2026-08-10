import { describe, expect, it, vi } from "vitest";
import { createExaClient, ExaSearchClient } from "./exa";

describe("ExaSearchClient", () => {
  it("is absent without EXA_API_KEY", () => {
    expect(createExaClient({})).toBeUndefined();
  });

  it("posts a highlights-only search body", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        requestId: "r1",
        results: [{ title: "T", url: "https://example.com/a", highlights: ["h"] }],
      }), { status: 200 }),
    );
    const client = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.search({
      query: "coral bleaching",
      numResults: 5,
      type: "auto",
      highlightMaxCharacters: 1_200,
      category: "publication",
    });
    expect(result.requestId).toBe("r1");
    expect(result.results).toHaveLength(1);
    const init = fetchImpl.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    expect(body.type).toBe("auto");
    expect(body.numResults).toBe(5);
    expect(body.contents).toEqual({ highlights: { maxCharacters: 1_200 } });
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("summary");
  });

  it("is present, and trims the key, once EXA_API_KEY is configured", () => {
    const client = createExaClient({ EXA_API_KEY: "  exa_test  " });
    expect(client).toBeInstanceOf(ExaSearchClient);
  });

  it("uses a configured Exa-compatible base URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://search.example.com/search");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = createExaClient({ EXA_API_KEY: "key", EXA_BASE_URL: "https://search.example.com/" }, fetchImpl)!;
    await client.search({ query: "test", numResults: 1, type: "fast", highlightMaxCharacters: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to construct without a real key", () => {
    expect(() => new ExaSearchClient({ apiKey: "   " })).toThrow("EXA_API_KEY");
  });

  const client = () => new ExaSearchClient({ apiKey: "exa_test", fetchImpl: vi.fn() as unknown as typeof fetch });

  it("validates the query and result bounds before ever calling fetch", async () => {
    await expect(client().search({ query: "  ", numResults: 5, type: "auto", highlightMaxCharacters: 1_000 })).rejects.toThrow("query is required");
    await expect(client().search({ query: "x", numResults: 0, type: "auto", highlightMaxCharacters: 1_000 })).rejects.toThrow("numResults");
    await expect(client().search({ query: "x", numResults: 11, type: "auto", highlightMaxCharacters: 1_000 })).rejects.toThrow("numResults");
    await expect(client().search({ query: "x", numResults: 5, type: "auto", highlightMaxCharacters: 100 })).rejects.toThrow("highlightMaxCharacters");
    await expect(client().search({ query: "x", numResults: 5, type: "auto", highlightMaxCharacters: 5_000 })).rejects.toThrow("highlightMaxCharacters");
  });

  it("surfaces a non-ok response as an error carrying the status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.search({ query: "x", numResults: 1, type: "auto", highlightMaxCharacters: 1_000 })).rejects.toThrow(/429.*rate limited/s);
  });

  it("drops results with no url, and falls back to the url when there is no title", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Has a title", url: "https://example.com/a", highlights: [" padded  "] },
        { url: "https://example.com/b" }, // no title — falls back to the url
        { title: "No url at all" }, // dropped entirely
      ],
    }), { status: 200 }));
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.search({ query: "x", numResults: 3, type: "auto", highlightMaxCharacters: 1_000 });
    expect(result.results).toEqual([
      { title: "Has a title", url: "https://example.com/a", publishedDate: null, author: null, highlights: ["padded"] },
      { title: "https://example.com/b", url: "https://example.com/b", publishedDate: null, author: null, highlights: [] },
    ]);
  });

  it("reports no request id rather than inventing one when the API omits it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const c = new ExaSearchClient({ apiKey: "exa_test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await c.search({ query: "x", numResults: 1, type: "auto", highlightMaxCharacters: 1_000 });
    expect(result.requestId).toBeNull();
  });
});
