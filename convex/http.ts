import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

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

export default http;
