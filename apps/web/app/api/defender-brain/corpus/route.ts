import { defenderCorpus } from "@/lib/defender-feed-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const corpus = await defenderCorpus();
    const etag = `"sha256-${corpus.digest}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    const body = new Uint8Array(corpus.bytes.byteLength);
    body.set(corpus.bytes);
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": String(corpus.bytes.byteLength),
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
        etag,
      },
    });
  } catch {
    return Response.json({ error: "defender_corpus_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
