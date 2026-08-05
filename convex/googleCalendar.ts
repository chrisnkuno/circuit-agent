"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { decryptVaultValue, encryptVaultValue, parseVaultKey, randomSecret, secretHash, type VaultEnvelope } from "../lib/credential-vault";
import { buildGoogleAuthorizationUrl, createGoogleCalendarEvent, exchangeGoogleCode, listGoogleCalendarEvents, pkceChallenge, refreshGoogleToken, validateCalendarEventInput, watchGoogleCalendar, type CalendarEventInput, type CalendarEventSummary, type GoogleTokenBundle } from "../lib/google-calendar";

const eventInput = v.object({ summary: v.string(), description: v.optional(v.string()), location: v.optional(v.string()), start: v.string(), end: v.string(), timeZone: v.string() });
const eventSummary = v.object({ id: v.string(), summary: v.string(), start: v.string(), end: v.string(), status: v.string(), htmlLink: v.optional(v.string()) });
// The explicit boundary avoids recursive generated-API inference between this action module and its internal model module.
const calendarModel = (internal as any).googleCalendarModel;

export const beginOAuth = action({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ authorizationUrl: v.string() }),
  handler: async (ctx, { organizationId }): Promise<{ authorizationUrl: string }> => {
    const identity = await requireIdentity(ctx);
    await ctx.runQuery(calendarModel.authorizeOAuthStart, { organizationId, identitySubject: identity.subject });
    const config = googleConfig();
    const state = randomSecret(32);
    const verifier = randomSecret(48);
    const pkce = encryptVaultValue({ verifier }, vaultKey());
    await ctx.runMutation(calendarModel.storeOAuthAttempt, { organizationId, identitySubject: identity.subject, stateHash: secretHash(state), redirectUri: config.redirectUri, expiresAt: Date.now() + 10 * 60_000, pkce });
    return { authorizationUrl: buildGoogleAuthorizationUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state, codeChallenge: pkceChallenge(verifier) }) };
  },
});

export const completeOAuth = action({
  args: { code: v.string(), state: v.string() },
  returns: v.object({ organizationId: v.id("organizations"), connectionId: v.id("connectorConnections"), watchActive: v.boolean() }),
  handler: async (ctx, args): Promise<{ organizationId: Id<"organizations">; connectionId: Id<"connectorConnections">; watchActive: boolean }> => {
    const identity = await requireIdentity(ctx);
    const consumed = await ctx.runMutation(calendarModel.consumeOAuthAttempt, { stateHash: secretHash(args.state), identitySubject: identity.subject, now: Date.now() }) as { attempt: { organizationId: Id<"organizations">; redirectUri: string }; pkce: { algorithm: "aes-256-gcm"; keyVersion: number; iv: string; ciphertext: string; authTag: string } };
    const pkce = decryptVaultValue<{ verifier: string }>(toEnvelope(consumed.pkce), vaultKey());
    const config = googleConfig();
    const tokens = await exchangeGoogleCode({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: consumed.attempt.redirectUri, code: args.code, codeVerifier: pkce.verifier });
    const connectionId = await ctx.runMutation(calendarModel.storeGoogleConnection, { organizationId: consumed.attempt.organizationId, token: encryptVaultValue(tokens, vaultKey()), expiresAt: tokens.expiresAt, scopes: tokens.scope.split(" ").filter(Boolean), accountLabel: "Primary Google Calendar" }) as Id<"connectorConnections">;
    let watchActive = false;
    if (process.env.GOOGLE_CALENDAR_WEBHOOK_URL) {
      await createWatch(ctx, consumed.attempt.organizationId, connectionId, tokens, process.env.GOOGLE_CALENDAR_WEBHOOK_URL);
      watchActive = true;
    }
    return { organizationId: consumed.attempt.organizationId, connectionId, watchActive };
  },
});

export const listUpcoming = action({
  args: { organizationId: v.id("organizations"), timeMin: v.string(), timeMax: v.string(), maxResults: v.optional(v.number()) },
  returns: v.array(eventSummary),
  handler: async (ctx, args): Promise<CalendarEventSummary[]> => {
    const identity = await requireIdentity(ctx);
    const connection = await ctx.runQuery(calendarModel.getConnectionForActor, { organizationId: args.organizationId, identitySubject: identity.subject, permission: "task:read" }) as Doc<"connectorConnections">;
    const tokens = await activeTokens(ctx, connection);
    return listGoogleCalendarEvents({ accessToken: tokens.accessToken, timeMin: args.timeMin, timeMax: args.timeMax, maxResults: args.maxResults ?? 25 });
  },
});

export const proposeEvent = action({
  args: { organizationId: v.id("organizations"), taskId: v.id("tasks"), event: eventInput, idempotencyKey: v.string() },
  returns: v.id("connectorActionIntents"),
  handler: async (ctx, args): Promise<Id<"connectorActionIntents">> => {
    const identity = await requireIdentity(ctx);
    const event = validateCalendarEventInput(args.event);
    const connection = await ctx.runQuery(calendarModel.getConnectionForActor, { organizationId: args.organizationId, identitySubject: identity.subject, permission: "agent:run" }) as Doc<"connectorConnections">;
    if (!args.idempotencyKey.trim() || args.idempotencyKey.length > 200) throw new Error("A bounded idempotency key is required");
    const inputSummary = `${event.summary} · ${event.start} to ${event.end} · ${event.timeZone}`.slice(0, 1_000);
    return ctx.runMutation(calendarModel.proposeEventIntent, { organizationId: args.organizationId, identitySubject: identity.subject, taskId: args.taskId, connectionId: connection._id, inputSummary, idempotencyKey: args.idempotencyKey, payload: encryptVaultValue(event, vaultKey()) }) as Promise<Id<"connectorActionIntents">>;
  },
});

export const executeApprovedEvent = action({
  args: { actionIntentId: v.id("connectorActionIntents") },
  returns: eventSummary,
  handler: async (ctx, args): Promise<CalendarEventSummary> => {
    const identity = await requireIdentity(ctx);
    const { intent, connection } = await ctx.runQuery(calendarModel.getApprovedEventIntent, { actionIntentId: args.actionIntentId, identitySubject: identity.subject }) as { intent: Doc<"connectorActionIntents">; connection: Doc<"connectorConnections"> };
    if (!intent.payloadReference) throw new Error("Approved calendar payload is missing");
    const [payloadEntry, tokens] = await Promise.all([
      ctx.runQuery(calendarModel.getVaultEntry, { organizationId: intent.organizationId, reference: intent.payloadReference, kind: "action_payload" }) as Promise<Doc<"connectorVaultEntries">>,
      activeTokens(ctx, connection),
    ]);
    const event = decryptVaultValue<CalendarEventInput>(toEnvelope(payloadEntry), vaultKey());
    try {
      const result = await createGoogleCalendarEvent({ accessToken: tokens.accessToken, event, idempotencyKey: intent.idempotencyKey });
      await ctx.runMutation(calendarModel.recordEventResult, { actionIntentId: intent._id, status: "completed", summary: `Created Google Calendar event ${result.id}.` });
      return result;
    } catch (error) {
      await ctx.runMutation(calendarModel.recordEventResult, { actionIntentId: intent._id, status: "failed", summary: error instanceof Error ? error.message : "Google Calendar event creation failed" });
      throw error;
    }
  },
});

export const enableWatch = action({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ expiration: v.number() }),
  handler: async (ctx, args): Promise<{ expiration: number }> => {
    const identity = await requireIdentity(ctx);
    const connection = await ctx.runQuery(calendarModel.getConnectionForActor, { organizationId: args.organizationId, identitySubject: identity.subject, permission: "connector:manage" }) as Doc<"connectorConnections">;
    const webhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    if (!webhookUrl?.startsWith("https://")) throw new Error("GOOGLE_CALENDAR_WEBHOOK_URL must be a public HTTPS URL");
    return createWatch(ctx, args.organizationId, connection._id, await activeTokens(ctx, connection), webhookUrl);
  },
});

export const revoke = action({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const identity = await requireIdentity(ctx);
    const connection = await ctx.runQuery(calendarModel.getConnectionForActor, { organizationId: args.organizationId, identitySubject: identity.subject, permission: "connector:manage" }) as Doc<"connectorConnections">;
    const tokens = await activeTokens(ctx, connection);
    const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refreshToken)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!response.ok && response.status !== 400) throw new Error(`Google token revocation failed (${response.status})`);
    await ctx.runMutation(calendarModel.revokeGoogleConnection, { organizationId: args.organizationId, connectionId: connection._id, identitySubject: identity.subject });
    return null;
  },
});

export const runDueSchedules = internalAction({
  args: {},
  returns: v.object({ claimed: v.number(), completed: v.number(), failed: v.number() }),
  handler: async (ctx): Promise<{ claimed: number; completed: number; failed: number }> => {
    const workerId = `calendar_schedule_${crypto.randomUUID()}`;
    const claims = await ctx.runMutation(calendarModel.claimDueSchedules, { now: Date.now(), workerId, leaseMs: 120_000, limit: 10 }) as Array<{ runId: Id<"connectorScheduleRuns">; schedule: Doc<"agentSchedules"> }>;
    let completed = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        const connection = await ctx.runQuery(calendarModel.getConnectionInternal, { organizationId: claim.schedule.organizationId }) as Doc<"connectorConnections">;
        const tokens = await activeTokens(ctx, connection);
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
        const events = await listGoogleCalendarEvents({ accessToken: tokens.accessToken, timeMin, timeMax, maxResults: 50 });
        await ctx.runMutation(calendarModel.completeScheduleRun, { runId: claim.runId, workerId, status: "completed", summary: `Calendar digest completed with ${events.length} event${events.length === 1 ? "" : "s"} in the next 24 hours.` });
        completed += 1;
      } catch (error) {
        await ctx.runMutation(calendarModel.completeScheduleRun, { runId: claim.runId, workerId, status: "failed", summary: error instanceof Error ? error.message.slice(0, 500) : "Calendar digest failed" });
        failed += 1;
      }
    }
    return { claimed: claims.length, completed, failed };
  },
});

async function activeTokens(ctx: ActionCtx, connection: Doc<"connectorConnections">): Promise<GoogleTokenBundle> {
  const entry = await ctx.runQuery(calendarModel.getVaultEntry, { organizationId: connection.organizationId, reference: connection.credentialReference, kind: "oauth_tokens" }) as Doc<"connectorVaultEntries">;
  let tokens = decryptVaultValue<GoogleTokenBundle>(toEnvelope(entry), vaultKey());
  if (tokens.expiresAt <= Date.now() + 60_000) {
    const config = googleConfig();
    tokens = await refreshGoogleToken({ clientId: config.clientId, clientSecret: config.clientSecret, bundle: tokens });
    await ctx.runMutation(calendarModel.updateVaultEntry, { vaultId: entry._id, organizationId: connection.organizationId, envelope: encryptVaultValue(tokens, vaultKey()) });
  }
  return tokens;
}

async function createWatch(ctx: ActionCtx, organizationId: Id<"organizations">, connectionId: Id<"connectorConnections">, tokens: GoogleTokenBundle, webhookUrl: string) {
  const channelId = crypto.randomUUID();
  const channelToken = randomSecret(32);
  const expiration = Date.now() + 6 * 24 * 60 * 60_000;
  const watched = await watchGoogleCalendar({ accessToken: tokens.accessToken, webhookUrl, channelId, channelToken, expiration });
  await ctx.runMutation(calendarModel.storeWatchChannel, { organizationId, connectionId, channelId: watched.channelId, resourceId: watched.resourceId, tokenHash: secretHash(channelToken), expiration: watched.expiration });
  return { expiration: watched.expiration };
}

function toEnvelope(entry: { algorithm: "aes-256-gcm"; keyVersion: number; iv: string; ciphertext: string; authTag: string }): VaultEnvelope {
  return { algorithm: entry.algorithm, keyVersion: entry.keyVersion, iv: entry.iv, ciphertext: entry.ciphertext, authTag: entry.authTag };
}

function googleConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google OAuth is not configured");
  if (!redirectUri.startsWith("https://") && !redirectUri.startsWith("http://localhost:")) throw new Error("Google OAuth redirect URI must be HTTPS outside localhost");
  return { clientId, clientSecret, redirectUri };
}

function vaultKey() { return parseVaultKey(process.env.CONNECTOR_VAULT_KEY); }

async function requireIdentity(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return identity;
}
