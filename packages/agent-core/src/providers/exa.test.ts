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
});
