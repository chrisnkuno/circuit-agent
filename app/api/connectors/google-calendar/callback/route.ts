import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { fetchAuthAction } from "@/lib/auth-server";

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const destination = new URL("/", incoming.origin);
  const providerError = incoming.searchParams.get("error");
  const code = incoming.searchParams.get("code");
  const state = incoming.searchParams.get("state");
  if (providerError) {
    destination.searchParams.set("calendar", "denied");
    return NextResponse.redirect(destination);
  }
  if (!code || !state) {
    destination.searchParams.set("calendar", "invalid_callback");
    return NextResponse.redirect(destination);
  }
  try {
    const result = await fetchAuthAction(api.googleCalendar.completeOAuth, { code, state });
    destination.searchParams.set("calendar", result.watchActive ? "connected_watching" : "connected");
  } catch (error) {
    destination.searchParams.set("calendar", "failed");
    destination.searchParams.set("reason", error instanceof Error ? error.message.slice(0, 120) : "oauth_error");
  }
  return NextResponse.redirect(destination);
}
