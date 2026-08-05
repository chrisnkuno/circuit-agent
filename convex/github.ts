"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { randomSecret, secretHash } from "../lib/credential-vault";
import { buildAppJwt, buildInstallationUrl, getInstallationDetails, listInstallationRepositories, mintInstallationToken, uninstallApp } from "../lib/providers/github";

// The explicit boundary avoids recursive generated-API inference between this action module and its internal model module.
const githubModel = (internal as any).githubModel;

export const beginInstall = action({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ installationUrl: v.string() }),
  handler: async (ctx, { organizationId }): Promise<{ installationUrl: string }> => {
    const identity = await requireIdentity(ctx);
    await ctx.runQuery(githubModel.authorizeInstallStart, { organizationId, identitySubject: identity.subject });
    const config = appConfig();
    const state = randomSecret(32);
    await ctx.runMutation(githubModel.storeInstallAttempt, { organizationId, identitySubject: identity.subject, stateHash: secretHash(state), expiresAt: Date.now() + 10 * 60_000 });
    return { installationUrl: buildInstallationUrl(config.appSlug, state) };
  },
});

export const completeInstall = action({
  args: { installationId: v.string(), state: v.string() },
  returns: v.object({ organizationId: v.id("organizations"), installationId: v.string() }),
  handler: async (ctx, args): Promise<{ organizationId: Id<"organizations">; installationId: string }> => {
    const identity = await requireIdentity(ctx);
    const consumed = await ctx.runMutation(githubModel.consumeInstallAttempt, { stateHash: secretHash(args.state), identitySubject: identity.subject, now: Date.now() }) as { organizationId: Id<"organizations"> };
    const config = appConfig();
    const jwt = buildAppJwt({ appId: config.appId, privateKeyPem: config.privateKeyPem });
    // Never trust installation identity from the browser redirect; re-resolve it from GitHub.
    const details = await getInstallationDetails(args.installationId, jwt);
    const { token } = await mintInstallationToken(args.installationId, jwt);
    const allowedRepositories = await listInstallationRepositories(token);
    await ctx.runMutation(githubModel.storeInstallation, {
      organizationId: consumed.organizationId, installationId: details.installationId, accountLogin: details.accountLogin,
      accountType: details.accountType, repositorySelection: details.repositorySelection, allowedRepositories,
    });
    return { organizationId: consumed.organizationId, installationId: details.installationId };
  },
});

export const revoke = action({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const identity = await requireIdentity(ctx);
    const installation = await ctx.runQuery(githubModel.getInstallationForActor, { organizationId: args.organizationId, identitySubject: identity.subject, permission: "connector:manage" }) as Doc<"githubInstallations">;
    const config = appConfig();
    const jwt = buildAppJwt({ appId: config.appId, privateKeyPem: config.privateKeyPem });
    await uninstallApp(installation.installationId, jwt);
    await ctx.runMutation(githubModel.revokeInstallation, { organizationId: args.organizationId, installationId: installation.installationId, identitySubject: identity.subject });
    return null;
  },
});

function appConfig() {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !appSlug || !privateKeyPem) throw new Error("GitHub App is not configured");
  return { appId, appSlug, privateKeyPem };
}

async function requireIdentity(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return identity;
}
