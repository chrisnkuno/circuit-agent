import { NextRequest, NextResponse } from "next/server";

const ENDPOINTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/rwf.json",
  "https://latest.currency-api.pages.dev/v1/currencies/rwf.json",
];

type RatePayload = { date?: unknown; rwf?: Record<string, unknown> };

export async function GET(request: NextRequest) {
  const currency = request.nextUrl.searchParams.get("currency")?.trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: "A valid currency code is required" }, { status: 400 });
  if (currency === "RWF") return NextResponse.json({ base: "RWF", currency, rate: 1, date: new Date().toISOString().slice(0, 10) });

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(endpoint, { next: { revalidate: 21_600 }, signal: AbortSignal.timeout(4_000) });
      if (!response.ok) continue;
      const payload = await response.json() as RatePayload;
      const rate = payload.rwf?.[currency.toLowerCase()];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
      return NextResponse.json(
        { base: "RWF", currency, rate, date: typeof payload.date === "string" ? payload.date : null },
        { headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" } },
      );
    } catch {
      // Try the documented fallback host before reporting the rate as unavailable.
    }
  }
  return NextResponse.json({ error: `No current RWF/${currency} rate is available` }, { status: 503 });
}
