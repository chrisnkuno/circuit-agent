import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";

const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";

/**
 * One Convex deployment serves local development, the Playwright acceptance ports, and the
 * deployed site, so a single fixed baseURL is wrong for two of the three: Better Auth builds its
 * cookies and redirects from it, and a mismatch fails authentication outright.
 *
 * Better Auth resolves the base URL per request instead — it takes the host from
 * x-forwarded-host, then the Host header, then the request URL, and accepts it only if it matches
 * this allowlist. Entries here are also added to trustedOrigins automatically.
 * https://better-auth.com/docs/guides/dynamic-base-url
 */
const allowedHosts = Array.from(new Set([
  ...(() => { try { return [new URL(siteUrl).host]; } catch { return []; } })(),
  "localhost:3000",
  "127.0.0.1:3000",
  "localhost:3100",
  "127.0.0.1:3100",
  "localhost:3179",
  "127.0.0.1:3179",
  "*.vercel.app",
]));

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: { allowedHosts, fallback: siteUrl },
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [convex({ authConfig })],
  });
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.safeGetAuthUser(ctx);
  },
});
