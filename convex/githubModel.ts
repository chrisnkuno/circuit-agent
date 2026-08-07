import { v } from "convex/values";
import { hasPermission, type Permission } from "../lib/authz";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

export const listForOrganization = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("githubInstallations").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
  },
});

/**
 * Whether this organization has a repository a run could actually work against. Internal because
 * it shapes the run graph rather than answering a user's question, and it must be callable from
 * the run-creation path where there is no session to authorize against.
 */
export const hasConnectedRepository = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.boolean(),
  handler: async (ctx, { organizationId }) => {
    const installations = await ctx.db
      .query("githubInstallations")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(20);
    return installations.some((installation) => installation.status === "connected");
  },
});

export const authorizeInstallStart = internalQuery({
  args: { organizationId: v.id("organizations"), identitySubject: v.string() },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, "connector:manage");
    return true;
  },
});

export const storeInstallAttempt = internalMutation({
  args: { organizationId: v.id("organizations"), identitySubject: v.string(), stateHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("githubInstallAttempts", { ...args, createdAt: Date.now() });
  },
});

export const consumeInstallAttempt = internalMutation({
  args: { stateHash: v.string(), identitySubject: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.query("githubInstallAttempts").withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash)).unique();
    if (!attempt) throw new Error("GitHub installation state is invalid");
    if (attempt.identitySubject !== args.identitySubject) throw new Error("GitHub installation state belongs to another user");
    if (attempt.consumedAt || attempt.expiresAt <= args.now) throw new Error("GitHub installation state is expired or already used");
    await ctx.db.patch(attempt._id, { consumedAt: args.now });
    return { organizationId: attempt.organizationId };
  },
});

export const storeInstallation = internalMutation({
  args: {
    organizationId: v.id("organizations"), installationId: v.string(), accountLogin: v.string(),
    accountType: v.union(v.literal("Organization"), v.literal("User")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    allowedRepositories: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("githubInstallations").withIndex("by_installation_id", (q) => q.eq("installationId", args.installationId)).unique();
    const fields = {
      organizationId: args.organizationId, accountLogin: args.accountLogin, accountType: args.accountType,
      repositorySelection: args.repositorySelection, allowedRepositories: [...new Set(args.allowedRepositories)],
      status: "connected" as const, updatedAt: now,
    };
    if (existing) {
      if (existing.organizationId !== args.organizationId) throw new Error("Installation is already linked to a different organization");
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return ctx.db.insert("githubInstallations", { installationId: args.installationId, connectedAt: now, ...fields });
  },
});

export const getInstallationForActor = internalQuery({
  args: { organizationId: v.id("organizations"), identitySubject: v.string(), permission: v.union(v.literal("task:read"), v.literal("agent:run"), v.literal("connector:manage")) },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, args.permission);
    const installation = await ctx.db.query("githubInstallations").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).first();
    if (!installation || installation.status !== "connected") throw new Error("GitHub is not connected");
    return installation;
  },
});

export const revokeInstallation = internalMutation({
  args: { organizationId: v.id("organizations"), installationId: v.string(), identitySubject: v.string() },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, "connector:manage");
    const installation = await ctx.db.query("githubInstallations").withIndex("by_installation_id", (q) => q.eq("installationId", args.installationId)).unique();
    if (!installation || installation.organizationId !== args.organizationId) throw new Error("GitHub installation not found");
    await ctx.db.patch(installation._id, { status: "revoked", updatedAt: Date.now() });
  },
});

/** Applies an already signature-verified webhook event; only updates an installation this control plane already linked. */
export const applyWebhookEvent = internalMutation({
  args: {
    installationId: v.string(),
    action: v.union(v.literal("deleted"), v.literal("suspend"), v.literal("unsuspend"), v.literal("repositories_changed")),
    repositoriesAdded: v.optional(v.array(v.string())),
    repositoriesRemoved: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db.query("githubInstallations").withIndex("by_installation_id", (q) => q.eq("installationId", args.installationId)).unique();
    if (!installation) return { applied: false };
    const now = Date.now();
    if (args.action === "deleted") await ctx.db.patch(installation._id, { status: "revoked", updatedAt: now });
    else if (args.action === "suspend") await ctx.db.patch(installation._id, { status: "suspended", updatedAt: now });
    else if (args.action === "unsuspend") await ctx.db.patch(installation._id, { status: "connected", updatedAt: now });
    else if (args.action === "repositories_changed") {
      const removed = new Set(args.repositoriesRemoved ?? []);
      const next = new Set(installation.allowedRepositories.filter((name) => !removed.has(name)));
      for (const name of args.repositoriesAdded ?? []) next.add(name);
      await ctx.db.patch(installation._id, { allowedRepositories: [...next], updatedAt: now });
    }
    return { applied: true };
  },
});

async function requireMembership(ctx: any, organizationId: any, identitySubject: string, permission: Permission) {
  const membership = await ctx.db.query("memberships").withIndex("by_organization_subject", (q: any) => q.eq("organizationId", organizationId).eq("identitySubject", identitySubject)).unique();
  if (!membership || membership.status !== "active" || !hasPermission(membership.role, permission)) throw new Error(`Missing organization permission: ${permission}`);
  return membership;
}
