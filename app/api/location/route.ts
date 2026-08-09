import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { currencyForCountry } from "@/lib/money";

export const dynamic = "force-dynamic";

/** Uses coarse deployment metadata only; no precise coordinates are collected or stored. */
export async function GET() {
  const requestHeaders = await headers();
  const candidate = requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry");
  const countryCode = candidate?.trim().toUpperCase() ?? null;
  return NextResponse.json({ countryCode: countryCode && currencyForCountry(countryCode) ? countryCode : null });
}
