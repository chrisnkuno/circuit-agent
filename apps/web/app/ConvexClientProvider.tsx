"use client";

import { ReactNode } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider, type AuthClient } from "@convex-dev/better-auth/react";
import { authClient } from "@/lib/auth-client";

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

// A client for the no-backend case. It points at a port nothing listens on, so the socket is
// refused instantly and its queries stay pending forever rather than resolving — which is what
// keeps the Convex hooks (useQuery, useMutation, useAction) from throwing "Could not find Convex
// client!" for the whole tree. It must NOT point at `*.convex.cloud`: that wildcard resolves to
// real Convex infrastructure, which answers with a fatal error and takes the app down. `logger:
// false` keeps the failed-connection noise out of the console.
let fallbackConvex: ConvexReactClient | null = null;
try {
  fallbackConvex = new ConvexReactClient("https://127.0.0.1:9", { logger: false });
} catch {
  // The SDK refused the address — the app still renders, just without Convex context.
  fallbackConvex = null;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convex) {
    return fallbackConvex
      ? <ConvexProvider client={fallbackConvex}>{children}</ConvexProvider>
      : <>{children}</>;
  }
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient as unknown as AuthClient}>
      {children}
    </ConvexBetterAuthProvider>
  );
}
