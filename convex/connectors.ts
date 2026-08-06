import { v } from "convex/values";
import { connectorRegistry, type ConnectorPermission } from "../lib/connectors";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { nextCronOccurrence } from "../lib/schedule";

const permission = v.union(v.literal("read"), v.literal("draft"), v.literal("execute"));

export const listForOrganization = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("connectorConnections").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
  },
});

export const listActionIntents = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("connectorActionIntents").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").take(50);
  },
});

export const listSchedules = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("agentSchedules").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
  },
});

/** Revokes local metadata. The provider token revocation is performed by the trusted connector runtime. */
export const revokeConnection = mutation({
  args: { connectionId: v.id("connectorConnections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get(connectionId);
    if (!connection) throw new Error("Connection not found");
    await requireOrganizationPermission(ctx, connection.organizationId, "connector:manage");
    const now = Date.now();
    await ctx.db.patch(connectionId, { status: "revoked", updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: connection.organizationId, connectionId, type: "connection_revoked", message: `${connection.connectorId} connection was revoked.`, createdAt: now });
  },
});

/** Called only by a trusted OAuth/API-key callback after secrets have been stored in the external vault. */
export const recordConnectionFromProvider = internalMutation({
  args: {
    organizationId: v.id("organizations"), connectorId: v.string(), permissions: v.array(permission),
    credentialReference: v.string(), externalAccountLabel: v.optional(v.string()), scopes: v.array(v.string()), expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!connectorRegistry.get(args.connectorId)) throw new Error(`Unknown connector: ${args.connectorId}`);
    if (!args.credentialReference.startsWith("vault://")) throw new Error("credentialReference must be an opaque vault reference");
    const now = Date.now();
    const existing = await ctx.db.query("connectorConnections").withIndex("by_organization_connector", (q) => q.eq("organizationId", args.organizationId).eq("connectorId", args.connectorId)).first();
    const fields = { permissions: dedupePermissions(args.permissions), credentialReference: args.credentialReference, externalAccountLabel: args.externalAccountLabel, scopes: [...new Set(args.scopes)], expiresAt: args.expiresAt, status: "connected" as const, updatedAt: now };
    const connectionId = existing ? (await ctx.db.patch(existing._id, fields), existing._id) : await ctx.db.insert("connectorConnections", { organizationId: args.organizationId, connectorId: args.connectorId, connectedAt: now, ...fields });
    await ctx.db.insert("connectorEvents", { organizationId: args.organizationId, connectionId, type: existing ? "connection_refreshed" : "connection_created", message: `${args.connectorId} connection metadata recorded; credentials remain in the vault.`, createdAt: now });
    return connectionId;
  },
});

/** Creates the durable side-effect boundary before a connector worker is allowed to run. */
export const proposeActionIntent = internalMutation({
  args: {
    organizationId: v.id("organizations"), taskId: v.id("tasks"), runId: v.optional(v.id("agentRuns")), stepId: v.optional(v.id("agentSteps")),
    connectionId: v.id("connectorConnections"), connectorId: v.string(), actionId: v.string(), inputSummary: v.string(), idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("connectorActionIntents").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return existing._id;
    const task = await ctx.db.get(args.taskId);
    const connection = await ctx.db.get(args.connectionId);
    if (!task || task.organizationId !== args.organizationId) throw new Error("Task organization mismatch");
    if (!connection || connection.organizationId !== args.organizationId || connection.connectorId !== args.connectorId || connection.status !== "connected") throw new Error("Connected account not found");
    if (!connection.credentialReference.startsWith("vault://")) throw new Error("Invalid credential reference");
    if (connection.expiresAt !== undefined && connection.expiresAt <= Date.now()) throw new Error("Connection expired");
    const action = connectorRegistry.action(args.connectorId, args.actionId);
    if (!grantsPermission(connection.permissions, action.permission)) throw new Error(`Connection lacks ${action.permission} permission`);
    const now = Date.now();
    const intentId = await ctx.db.insert("connectorActionIntents", {
      organizationId: args.organizationId, taskId: args.taskId, runId: args.runId, stepId: args.stepId, connectionId: args.connectionId,
      connectorId: args.connectorId, actionId: args.actionId, permission: action.permission, risk: action.risk,
      status: action.requiresApproval ? "awaiting_approval" : "proposed", idempotencyKey: args.idempotencyKey, inputSummary: args.inputSummary, createdAt: now, updatedAt: now,
    });
    if (action.requiresApproval) await ctx.db.insert("approvals", { taskId: args.taskId, runId: args.runId, stepId: args.stepId, actionIntentId: intentId, kind: "external_action", status: "pending", requestedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: args.organizationId, connectionId: args.connectionId, actionIntentId: intentId, type: "action_proposed", message: action.requiresApproval ? "External action is awaiting approval." : "Read action is ready for execution.", createdAt: now });
    return intentId;
  },
});

export const recordActionResult = internalMutation({
  args: { actionIntentId: v.id("connectorActionIntents"), outcome: v.union(v.literal("completed"), v.literal("failed")), outputSummary: v.string() },
  handler: async (ctx, { actionIntentId, outcome, outputSummary }) => {
    const intent = await ctx.db.get(actionIntentId);
    if (!intent || !["proposed", "approved", "executing"].includes(intent.status)) throw new Error("Executable action intent not found");
    if (intent.risk !== "read" && intent.status !== "approved" && intent.status !== "executing") throw new Error("External action has not been approved");
    const now = Date.now();
    await ctx.db.patch(actionIntentId, { status: outcome, outputSummary, updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: intent.organizationId, connectionId: intent.connectionId, actionIntentId, type: `action_${outcome}`, message: outputSummary, createdAt: now });
  },
});

const executableWorkflowTemplates = new Set(["calendar-digest", "coding-task"]);

export const createSchedule = mutation({
  args: { organizationId: v.id("organizations"), title: v.string(), workflowTemplate: v.string(), cronExpression: v.string(), timezone: v.string(), connectorIds: v.array(v.string()), objective: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "connector:manage");
    if (!args.title.trim() || !args.cronExpression.trim() || !args.timezone.trim()) throw new Error("Schedule title, cron expression, and timezone are required");
    if (!executableWorkflowTemplates.has(args.workflowTemplate)) throw new Error("Unknown workflow template");
    nextCronOccurrence(args.cronExpression, args.timezone, Date.now());
    const now = Date.now();
    if (args.workflowTemplate === "coding-task") {
      const objective = args.objective?.trim();
      if (!objective || objective.length > 500) throw new Error("A coding-task schedule requires an objective of 1 to 500 characters");
      if (args.connectorIds.length > 0) throw new Error("coding-task schedules do not use connectors");
      return ctx.db.insert("agentSchedules", { organizationId: args.organizationId, title: args.title.trim(), workflowTemplate: args.workflowTemplate, cronExpression: args.cronExpression, timezone: args.timezone, status: "paused", connectorIds: [], objective, createdAt: now, updatedAt: now });
    }
    for (const connectorId of args.connectorIds) if (!connectorRegistry.get(connectorId)) throw new Error(`Unknown connector: ${connectorId}`);
    const connections = await ctx.db.query("connectorConnections").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).collect();
    for (const connectorId of args.connectorIds) if (!connections.some((item) => item.connectorId === connectorId && item.status === "connected")) throw new Error(`${connectorId} is not connected`);
    return ctx.db.insert("agentSchedules", { organizationId: args.organizationId, title: args.title.trim(), workflowTemplate: args.workflowTemplate, cronExpression: args.cronExpression, timezone: args.timezone, status: "paused", connectorIds: [...new Set(args.connectorIds)], createdAt: now, updatedAt: now });
  },
});

export const setScheduleStatus = mutation({
  args: { scheduleId: v.id("agentSchedules"), status: v.union(v.literal("active"), v.literal("paused"), v.literal("disabled")) },
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) throw new Error("Schedule not found");
    await requireOrganizationPermission(ctx, schedule.organizationId, "connector:manage");
    const now = Date.now();
    if (args.status === "active") {
      const connections = await ctx.db.query("connectorConnections").withIndex("by_organization", (q) => q.eq("organizationId", schedule.organizationId)).collect();
      for (const connectorId of schedule.connectorIds) if (!connections.some((item) => item.connectorId === connectorId && item.status === "connected")) throw new Error(`${connectorId} is not connected`);
      await ctx.db.patch(schedule._id, { status: "active", nextRunAt: nextCronOccurrence(schedule.cronExpression, schedule.timezone, now), claimedBy: undefined, claimExpiresAt: undefined, updatedAt: now });
    } else {
      await ctx.db.patch(schedule._id, { status: args.status, nextRunAt: undefined, claimedBy: undefined, claimExpiresAt: undefined, updatedAt: now });
    }
  },
});

function dedupePermissions(permissions: ConnectorPermission[]): ConnectorPermission[] {
  return [...new Set(permissions)];
}

function grantsPermission(grants: ConnectorPermission[], required: ConnectorPermission): boolean {
  const rank: Record<ConnectorPermission, number> = { read: 0, draft: 1, execute: 2 };
  return grants.some((grant) => rank[grant] >= rank[required]);
}
