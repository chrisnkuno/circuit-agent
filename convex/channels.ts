import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

const channel = v.union(v.literal("telegram"));

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomLinkCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const listForOrganization = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("channelLinks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
  },
});

/**
 * Starts a short-lived, single-use pairing code the user sends back through the channel
 * itself (e.g. "/link CODE" in Telegram) to bind it to their organization. This mirrors the
 * GitHub App install / Google OAuth state pattern used elsewhere: an external identity is
 * only ever trusted once it presents this code back through the channel's own verified
 * webhook, never from anything the browser alone asserts.
 */
export const startLinkAttempt = mutation({
  args: { organizationId: v.id("organizations"), channel },
  handler: async (ctx, args) => {
    const { identity } = await requireOrganizationPermission(ctx, args.organizationId, "connector:manage");
    const code = randomLinkCode();
    const now = Date.now();
    await ctx.db.insert("channelLinkAttempts", {
      organizationId: args.organizationId, identitySubject: identity.subject, channel: args.channel,
      codeHash: await sha256Hex(code), expiresAt: now + 15 * 60_000, createdAt: now,
    });
    return { code, expiresInSeconds: 900 };
  },
});

/** Called only from the channel's own verified webhook handler after it receives "/link <code>". */
export const completeLinkAttempt = internalMutation({
  args: { channel, code: v.string(), channelUserId: v.string() },
  handler: async (ctx, args): Promise<{ status: "linked" | "expired" | "invalid"; organizationId?: import("./_generated/dataModel").Id<"organizations"> }> => {
    const codeHash = await sha256Hex(args.code);
    const attempt = await ctx.db.query("channelLinkAttempts").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!attempt || attempt.channel !== args.channel) return { status: "invalid" };
    if (attempt.consumedAt || attempt.expiresAt <= Date.now()) return { status: "expired" };
    await ctx.db.patch(attempt._id, { consumedAt: Date.now() });
    const now = Date.now();
    const existing = await ctx.db.query("channelLinks").withIndex("by_channel_user", (q) => q.eq("channel", args.channel).eq("channelUserId", args.channelUserId)).unique();
    if (existing) await ctx.db.patch(existing._id, { organizationId: attempt.organizationId, status: "linked", linkedAt: now, updatedAt: now });
    else await ctx.db.insert("channelLinks", { organizationId: attempt.organizationId, channel: args.channel, channelUserId: args.channelUserId, status: "linked", linkedAt: now, updatedAt: now });
    return { status: "linked", organizationId: attempt.organizationId };
  },
});

export const revokeLink = mutation({
  args: { linkId: v.id("channelLinks") },
  handler: async (ctx, { linkId }) => {
    const link = await ctx.db.get(linkId);
    if (!link) throw new Error("Channel link not found");
    await requireOrganizationPermission(ctx, link.organizationId, "connector:manage");
    await ctx.db.patch(linkId, { status: "revoked", updatedAt: Date.now() });
  },
});

/** Internal-only: resolves which organization a verified incoming channel message belongs to. */
export const resolveChannelUser = internalQuery({
  args: { channel, channelUserId: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.query("channelLinks").withIndex("by_channel_user", (q) => q.eq("channel", args.channel).eq("channelUserId", args.channelUserId)).unique();
    if (!link || link.status !== "linked") return null;
    return link;
  },
});

/** Internal-only: every channel linked to an organization, for pushing a run-completion notification. */
export const listLinkedForOrganization = internalQuery({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const links = await ctx.db.query("channelLinks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
    return links.filter((link) => link.status === "linked");
  },
});
