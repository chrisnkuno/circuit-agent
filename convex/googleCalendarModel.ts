import { v } from "convex/values";
import { hasPermission, type Permission } from "../lib/authz";
import { internalMutation, internalQuery } from "./_generated/server";
import { nextCronOccurrence } from "../lib/schedule";

const envelopeArgs = {
  algorithm: v.literal("aes-256-gcm"), keyVersion: v.number(), iv: v.string(), ciphertext: v.string(), authTag: v.string(),
};

export const authorizeOAuthStart = internalQuery({
  args: { organizationId: v.id("organizations"), identitySubject: v.string() },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, "connector:manage");
    return true;
  },
});

export const storeOAuthAttempt = internalMutation({
  args: { organizationId: v.id("organizations"), identitySubject: v.string(), stateHash: v.string(), redirectUri: v.string(), expiresAt: v.number(), pkce: v.object(envelopeArgs) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const vaultId = await ctx.db.insert("connectorVaultEntries", { organizationId: args.organizationId, kind: "oauth_pkce", ...args.pkce, createdAt: now, updatedAt: now });
    await ctx.db.insert("connectorOAuthStates", { organizationId: args.organizationId, identitySubject: args.identitySubject, connectorId: "google-calendar", stateHash: args.stateHash, pkceReference: `vault://convex/${vaultId}`, redirectUri: args.redirectUri, expiresAt: args.expiresAt, createdAt: now });
  },
});

export const consumeOAuthAttempt = internalMutation({
  args: { stateHash: v.string(), identitySubject: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.query("connectorOAuthStates").withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash)).unique();
    if (!attempt || attempt.connectorId !== "google-calendar") throw new Error("OAuth state is invalid");
    if (attempt.identitySubject !== args.identitySubject) throw new Error("OAuth state belongs to another user");
    if (attempt.consumedAt || attempt.expiresAt <= args.now) throw new Error("OAuth state is expired or already used");
    const vaultId = ctx.db.normalizeId("connectorVaultEntries", attempt.pkceReference.replace("vault://convex/", ""));
    if (!vaultId) throw new Error("OAuth PKCE reference is invalid");
    const pkce = await ctx.db.get(vaultId);
    if (!pkce || pkce.organizationId !== attempt.organizationId || pkce.kind !== "oauth_pkce") throw new Error("OAuth PKCE verifier not found");
    await ctx.db.patch(attempt._id, { consumedAt: args.now });
    await ctx.db.delete(pkce._id);
    return { attempt, pkce };
  },
});

export const storeGoogleConnection = internalMutation({
  args: { organizationId: v.id("organizations"), token: v.object(envelopeArgs), expiresAt: v.number(), scopes: v.array(v.string()), accountLabel: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const vaultId = await ctx.db.insert("connectorVaultEntries", { organizationId: args.organizationId, kind: "oauth_tokens", ...args.token, createdAt: now, updatedAt: now });
    const credentialReference = `vault://convex/${vaultId}`;
    const existing = await ctx.db.query("connectorConnections").withIndex("by_organization_connector", (q) => q.eq("organizationId", args.organizationId).eq("connectorId", "google-calendar")).first();
    const fields = { status: "connected" as const, permissions: ["read" as const, "draft" as const, "execute" as const], credentialReference, externalAccountLabel: args.accountLabel, scopes: args.scopes, expiresAt: args.expiresAt, updatedAt: now };
    const connectionId = existing ? (await ctx.db.patch(existing._id, fields), existing._id) : await ctx.db.insert("connectorConnections", { organizationId: args.organizationId, connectorId: "google-calendar", connectedAt: now, ...fields });
    if (existing?.credentialReference.startsWith("vault://convex/")) {
      const priorId = ctx.db.normalizeId("connectorVaultEntries", existing.credentialReference.replace("vault://convex/", ""));
      if (priorId) await ctx.db.delete(priorId);
    }
    await ctx.db.insert("connectorEvents", { organizationId: args.organizationId, connectionId, type: "google_oauth_connected", message: "Google Calendar connected with encrypted offline credentials.", createdAt: now });
    return connectionId;
  },
});

export const getConnectionForActor = internalQuery({
  args: { organizationId: v.id("organizations"), identitySubject: v.string(), permission: v.union(v.literal("task:read"), v.literal("agent:run"), v.literal("connector:manage")) },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, args.permission);
    return getConnectedCalendar(ctx, args.organizationId);
  },
});

export const getConnectionInternal = internalQuery({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => getConnectedCalendar(ctx, args.organizationId),
});

export const getVaultEntry = internalQuery({
  args: { organizationId: v.id("organizations"), reference: v.string(), kind: v.union(v.literal("oauth_tokens"), v.literal("oauth_pkce"), v.literal("action_payload")) },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("connectorVaultEntries", args.reference.replace("vault://convex/", ""));
    if (!id) throw new Error("Vault reference is invalid");
    const entry = await ctx.db.get(id);
    if (!entry || entry.organizationId !== args.organizationId || entry.kind !== args.kind) throw new Error("Vault entry not found");
    return entry;
  },
});

export const updateVaultEntry = internalMutation({
  args: { vaultId: v.id("connectorVaultEntries"), organizationId: v.id("organizations"), envelope: v.object(envelopeArgs) },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.vaultId);
    if (!entry || entry.organizationId !== args.organizationId) throw new Error("Vault entry not found");
    await ctx.db.patch(entry._id, { ...args.envelope, updatedAt: Date.now() });
  },
});

export const proposeEventIntent = internalMutation({
  args: { organizationId: v.id("organizations"), identitySubject: v.string(), taskId: v.id("tasks"), connectionId: v.id("connectorConnections"), inputSummary: v.string(), idempotencyKey: v.string(), payload: v.object(envelopeArgs) },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, "agent:run");
    const task = await ctx.db.get(args.taskId);
    const connection = await ctx.db.get(args.connectionId);
    if (!task || task.organizationId !== args.organizationId) throw new Error("Task organization mismatch");
    if (!connection || connection.organizationId !== args.organizationId || connection.connectorId !== "google-calendar" || connection.status !== "connected") throw new Error("Google Calendar is not connected");
    const scopedKey = `${args.organizationId}:${args.idempotencyKey}`;
    const replay = await ctx.db.query("connectorActionIntents").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", scopedKey)).unique();
    if (replay) return replay._id;
    const now = Date.now();
    const payloadId = await ctx.db.insert("connectorVaultEntries", { organizationId: args.organizationId, kind: "action_payload", ...args.payload, createdAt: now, updatedAt: now });
    const intentId = await ctx.db.insert("connectorActionIntents", { organizationId: args.organizationId, taskId: args.taskId, connectionId: connection._id, connectorId: "google-calendar", actionId: "events.create", permission: "execute", risk: "write", status: "awaiting_approval", idempotencyKey: scopedKey, inputSummary: args.inputSummary, payloadReference: `vault://convex/${payloadId}`, createdAt: now, updatedAt: now });
    await ctx.db.insert("approvals", { taskId: task._id, actionIntentId: intentId, kind: "external_action", status: "pending", requestedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: args.organizationId, connectionId: connection._id, actionIntentId: intentId, type: "calendar_event_proposed", message: "Calendar event proposal is awaiting explicit approval.", createdAt: now });
    return intentId;
  },
});

export const getApprovedEventIntent = internalQuery({
  args: { actionIntentId: v.id("connectorActionIntents"), identitySubject: v.string() },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.actionIntentId);
    if (!intent || intent.connectorId !== "google-calendar" || intent.actionId !== "events.create") throw new Error("Calendar event intent not found");
    await requireMembership(ctx, intent.organizationId, args.identitySubject, "agent:run");
    if (intent.status !== "approved") throw new Error("Calendar event has not been approved");
    const connection = await ctx.db.get(intent.connectionId);
    if (!connection || connection.status !== "connected") throw new Error("Google Calendar connection is unavailable");
    return { intent, connection };
  },
});

export const recordEventResult = internalMutation({
  args: { actionIntentId: v.id("connectorActionIntents"), status: v.union(v.literal("completed"), v.literal("failed")), summary: v.string() },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.actionIntentId);
    if (!intent || intent.status !== "approved") throw new Error("Approved action intent not found");
    const now = Date.now();
    await ctx.db.patch(intent._id, { status: args.status, outputSummary: args.summary, updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: intent.organizationId, connectionId: intent.connectionId, actionIntentId: intent._id, type: `calendar_event_${args.status}`, message: args.summary, createdAt: now });
  },
});

export const storeWatchChannel = internalMutation({
  args: { organizationId: v.id("organizations"), connectionId: v.id("connectorConnections"), channelId: v.string(), resourceId: v.string(), tokenHash: v.string(), expiration: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("calendarWatchChannels").withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId)).filter((q) => q.eq(q.field("status"), "active")).collect();
    for (const channel of existing) await ctx.db.patch(channel._id, { status: "stopped", updatedAt: now });
    return ctx.db.insert("calendarWatchChannels", { ...args, status: "active", createdAt: now, updatedAt: now });
  },
});

export const revokeGoogleConnection = internalMutation({
  args: { organizationId: v.id("organizations"), connectionId: v.id("connectorConnections"), identitySubject: v.string() },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId, args.identitySubject, "connector:manage");
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.organizationId !== args.organizationId || connection.connectorId !== "google-calendar") throw new Error("Google Calendar connection not found");
    const now = Date.now();
    await ctx.db.patch(connection._id, { status: "revoked", updatedAt: now });
    if (connection.credentialReference.startsWith("vault://convex/")) {
      const vaultId = ctx.db.normalizeId("connectorVaultEntries", connection.credentialReference.replace("vault://convex/", ""));
      if (vaultId) await ctx.db.delete(vaultId);
    }
    const channels = await ctx.db.query("calendarWatchChannels").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).collect();
    for (const channel of channels) if (channel.status === "active") await ctx.db.patch(channel._id, { status: "stopped", updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: args.organizationId, connectionId: connection._id, type: "google_connection_revoked", message: "Google Calendar access was revoked.", createdAt: now });
  },
});

export const acceptWebhook = internalMutation({
  args: { channelId: v.string(), tokenHash: v.string(), resourceId: v.string(), resourceState: v.string(), messageNumber: v.number() },
  handler: async (ctx, args) => {
    const channel = await ctx.db.query("calendarWatchChannels").withIndex("by_channel_id", (q) => q.eq("channelId", args.channelId)).unique();
    if (!channel || channel.status !== "active" || channel.expiration <= Date.now()) throw new Error("Calendar webhook channel is inactive");
    if (channel.tokenHash !== args.tokenHash || channel.resourceId !== args.resourceId) throw new Error("Calendar webhook verification failed");
    if (channel.lastMessageNumber !== undefined && args.messageNumber <= channel.lastMessageNumber) return { duplicate: true };
    const now = Date.now();
    await ctx.db.patch(channel._id, { lastMessageNumber: args.messageNumber, updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: channel.organizationId, connectionId: channel.connectionId, type: "calendar_resource_changed", message: `Verified Google Calendar ${args.resourceState} notification.`, createdAt: now });
    return { duplicate: false };
  },
});

export const claimDueSchedules = internalMutation({
  args: { now: v.number(), workerId: v.string(), leaseMs: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.leaseMs) || args.leaseMs < 30_000 || args.leaseMs > 5 * 60_000) throw new Error("Schedule lease must be between 30 seconds and 5 minutes");
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) throw new Error("Schedule claim limit must be between 1 and 20");
    const expired = await ctx.db.query("connectorScheduleRuns").withIndex("by_status_lease", (q) => q.eq("status", "claimed").lte("leaseExpiresAt", args.now)).take(args.limit);
    for (const run of expired) await ctx.db.patch(run._id, { status: "failed", summary: "Schedule worker lease expired before completion.", completedAt: args.now });
    const due = await ctx.db.query("agentSchedules").withIndex("by_status_next_run", (q) => q.eq("status", "active").lte("nextRunAt", args.now)).take(args.limit);
    const claims = [];
    for (const schedule of due) {
      if (schedule.nextRunAt === undefined || schedule.workflowTemplate !== "calendar-digest") continue;
      const dueAt = schedule.nextRunAt;
      const idempotencyKey = `${schedule._id}:${dueAt}`;
      const replay = await ctx.db.query("connectorScheduleRuns").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey)).unique();
      const nextRunAt = nextCronOccurrence(schedule.cronExpression, schedule.timezone, dueAt);
      if (replay) {
        await ctx.db.patch(schedule._id, { nextRunAt, updatedAt: args.now });
        continue;
      }
      const runId = await ctx.db.insert("connectorScheduleRuns", { organizationId: schedule.organizationId, scheduleId: schedule._id, dueAt, idempotencyKey, status: "claimed", claimedBy: args.workerId, leaseExpiresAt: args.now + args.leaseMs, attempts: 1, createdAt: args.now });
      await ctx.db.patch(schedule._id, { claimedBy: args.workerId, claimExpiresAt: args.now + args.leaseMs, nextRunAt, updatedAt: args.now });
      claims.push({ runId, schedule });
    }
    return claims;
  },
});

export const completeScheduleRun = internalMutation({
  args: { runId: v.id("connectorScheduleRuns"), workerId: v.string(), status: v.union(v.literal("completed"), v.literal("failed")), summary: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "claimed" || run.claimedBy !== args.workerId || run.leaseExpiresAt <= Date.now()) throw new Error("Schedule worker does not own an active claim");
    const schedule = await ctx.db.get(run.scheduleId);
    const now = Date.now();
    await ctx.db.patch(run._id, { status: args.status, summary: args.summary, completedAt: now });
    if (schedule) await ctx.db.patch(schedule._id, { claimedBy: undefined, claimExpiresAt: undefined, lastRunAt: now, updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: run.organizationId, type: `calendar_digest_${args.status}`, message: args.summary, createdAt: now });
  },
});

async function requireMembership(ctx: any, organizationId: any, identitySubject: string, permission: Permission) {
  const membership = await ctx.db.query("memberships").withIndex("by_organization_subject", (q: any) => q.eq("organizationId", organizationId).eq("identitySubject", identitySubject)).unique();
  if (!membership || membership.status !== "active" || !hasPermission(membership.role, permission)) throw new Error(`Missing organization permission: ${permission}`);
  return membership;
}

async function getConnectedCalendar(ctx: any, organizationId: any) {
  const connection = await ctx.db.query("connectorConnections").withIndex("by_organization_connector", (q: any) => q.eq("organizationId", organizationId).eq("connectorId", "google-calendar")).first();
  if (!connection || connection.status !== "connected") throw new Error("Google Calendar is not connected");
  return connection;
}
