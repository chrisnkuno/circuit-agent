import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { fetchAuthAction } from "@/lib/auth-server";

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const destination = new URL("/", incoming.origin);
  const setupAction = incoming.searchParams.get("setup_action");
  const installationId = incoming.searchParams.get("installation_id");
  const state = incoming.searchParams.get("state");
  if (setupAction && setupAction !== "install" && setupAction !== "update") {
    destination.searchParams.set("github", "denied");
    return NextResponse.redirect(destination);
  }
  if (!installationId || !state) {
    destination.searchParams.set("github", "invalid_callback");
    return NextResponse.redirect(destination);
  }
  try {
    await fetchAuthAction(api.github.completeInstall, { installationId, state });
    destination.searchParams.set("github", "connected");
  } catch (error) {
    destination.searchParams.set("github", "failed");
    destination.searchParams.set("reason", error instanceof Error ? error.message.slice(0, 120) : "install_error");
  }
  return NextResponse.redirect(destination);
}
