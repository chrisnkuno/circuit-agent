import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";
import { parseTelegramUpdate, verifyTelegramSecret } from "../lib/telegram";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

http.route({
  path: "/google/calendar/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const channelId = request.headers.get("x-goog-channel-id");
    const channelToken = request.headers.get("x-goog-channel-token");
    const resourceId = request.headers.get("x-goog-resource-id");
    const resourceState = request.headers.get("x-goog-resource-state");
    const messageNumber = Number(request.headers.get("x-goog-message-number"));
    if (!channelId || !channelToken || !resourceId || !resourceState || !Number.isSafeInteger(messageNumber) || messageNumber < 1) return new Response("Invalid Google Calendar notification", { status: 400 });
    try {
      await ctx.runMutation((internal as any).googleCalendarModel.acceptWebhook, { channelId, tokenHash: await sha256Base64Url(channelToken), resourceId, resourceState, messageNumber });
      return new Response(null, { status: 204 });
    } catch {
      return new Response("Webhook verification failed", { status: 401 });
    }
  }),
});

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("x-hub-signature-256");
    const event = request.headers.get("x-github-event");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const payload = await request.text();
    if (!secret) return new Response("GitHub webhook is not configured", { status: 401 });
    if (!(await verifyGitHubSignature(payload, signature, secret))) return new Response("Webhook verification failed", { status: 401 });
    let body: any;
    try { body = JSON.parse(payload); } catch { return new Response("Invalid webhook payload", { status: 400 }); }
    const installationId = body?.installation?.id !== undefined ? String(body.installation.id) : undefined;
    if (!installationId) return new Response(null, { status: 204 });
    try {
      if (event === "installation" && (body.action === "deleted" || body.action === "suspend" || body.action === "unsuspend")) {
        await ctx.runMutation((internal as any).githubModel.applyWebhookEvent, { installationId, action: body.action });
      } else if (event === "installation_repositories" && (body.action === "added" || body.action === "removed")) {
        const added = Array.isArray(body.repositories_added) ? body.repositories_added.map((repo: any) => String(repo.full_name)) : [];
        const removed = Array.isArray(body.repositories_removed) ? body.repositories_removed.map((repo: any) => String(repo.full_name)) : [];
        await ctx.runMutation((internal as any).githubModel.applyWebhookEvent, { installationId, action: "repositories_changed", repositoriesAdded: added, repositoriesRemoved: removed });
      }
      return new Response(null, { status: 204 });
    } catch {
      return new Response("Webhook processing failed", { status: 500 });
    }
  }),
});

async function verifyGitHubSignature(payload: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const provided = signatureHeader.slice("sha256=".length);
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return mismatch === 0;
}

http.route({
  path: "/telegram/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return new Response("Telegram webhook is not configured", { status: 401 });
    if (!verifyTelegramSecret(request.headers.get("x-telegram-bot-api-secret-token"), secret)) {
      return new Response("Webhook verification failed", { status: 401 });
    }
    let body: unknown;
    try { body = await request.json(); } catch { return new Response("Invalid webhook payload", { status: 400 }); }
    const message = parseTelegramUpdate(body);
    if (message) {
      await ctx.runAction((internal as any).telegramActions.handleIncomingMessage, { chatId: message.chatId, text: message.text });
    }
    // Telegram retries on anything but 200, including for update types we deliberately ignore.
    return new Response(null, { status: 200 });
  }),
});

export default http;
