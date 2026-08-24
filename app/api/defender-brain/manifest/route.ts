import { NextResponse } from "next/server";
import { signedDefenderManifest } from "@/lib/defender-feed-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const manifest = await signedDefenderManifest(new URL(request.url).origin);
    const etag = `"defender-${manifest.sequence}-${manifest.corpus.sha256}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return NextResponse.json(manifest, { headers: { etag, "cache-control": "public, max-age=900, stale-while-revalidate=3600" } });
  } catch (error) {
    return NextResponse.json(
      { error: "defender_feed_unavailable", message: error instanceof Error ? error.message : "feed unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
