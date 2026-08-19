"use client";

import { ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider, type AuthClient } from "@convex-dev/better-auth/react";
import { authClient } from "@/lib/auth-client";
import { MoneyPreferencesProvider } from "@/components/money-preferences";

const rawUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

/**
 * Validate that the Convex URL is a real deployment and not a placeholder.
 * Real URLs look like `https://<name>.convex.cloud` or `https://<name>.convex.site`.
 * Placeholder values like `https://placeholder.convex.cloud` must be skipped.
 */
function isValidConvexUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    if (!host.endsWith(".convex.cloud") && !host.endsWith(".convex.site")) return false;
    const deploymentName = host.split(".")[0];
    if (!deploymentName || deploymentName === "placeholder" || deploymentName.length < 3) return false;
    return true;
  } catch {
    return false;
  }
}

let convex: ConvexReactClient | null = null;
if (isValidConvexUrl(rawUrl)) {
  try {
    convex = new ConvexReactClient(rawUrl);
  } catch {
    convex = null;
  }
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convex) {
    return <>{children}</>;
  }
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient as unknown as AuthClient}>
      <MoneyPreferencesProvider>{children}</MoneyPreferencesProvider>
    </ConvexBetterAuthProvider>
  );
}
