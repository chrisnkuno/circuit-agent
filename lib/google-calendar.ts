import { createHash } from "node:crypto";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type GoogleTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
};

export type CalendarEventInput = {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone: string;
};

export type CalendarEventSummary = {
  id: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  htmlLink?: string;
};

type Fetch = typeof fetch;

export function buildGoogleAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validateCalendarEventInput(input: CalendarEventInput): CalendarEventInput {
  const summary = input.summary.trim();
  if (!summary || summary.length > 300) throw new Error("Event summary must contain 1 to 300 characters");
  if (input.description && input.description.length > 8_000) throw new Error("Event description is too long");
  if (input.location && input.location.length > 1_000) throw new Error("Event location is too long");
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Event start and end must be valid and ordered");
  if (end - start > 31 * 24 * 60 * 60_000) throw new Error("Event duration cannot exceed 31 days");
  if (!input.timeZone.trim() || input.timeZone.length > 100) throw new Error("Event timezone is required");
  return { ...input, summary };
}

export async function exchangeGoogleCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }, request: Fetch = fetch): Promise<GoogleTokenBundle> {
  const response = await request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier }),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  return parseTokenResponse(body, undefined);
}

export async function refreshGoogleToken(input: { clientId: string; clientSecret: string; bundle: GoogleTokenBundle }, request: Fetch = fetch): Promise<GoogleTokenBundle> {
  const response = await request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.bundle.refreshToken, grant_type: "refresh_token" }),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Google token refresh failed (${response.status})`);
  return parseTokenResponse(body, input.bundle.refreshToken);
}

export async function listGoogleCalendarEvents(input: { accessToken: string; timeMin: string; timeMax: string; maxResults: number }, request: Fetch = fetch): Promise<CalendarEventSummary[]> {
  const min = Date.parse(input.timeMin);
  const max = Date.parse(input.timeMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max - min > 31 * 24 * 60 * 60_000) throw new Error("Calendar read window must be valid and no longer than 31 days");
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 100) throw new Error("maxResults must be between 1 and 100");
  const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/primary/events`);
  url.search = new URLSearchParams({ timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(), maxResults: String(input.maxResults), singleEvents: "true", orderBy: "startTime" }).toString();
  const response = await request(url, { headers: bearer(input.accessToken) });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Google Calendar read failed (${response.status})`);
  const items = Array.isArray(body.items) ? body.items : [];
  return items.map((item: any) => ({ id: String(item.id ?? ""), summary: String(item.summary ?? "(Busy)"), start: String(item.start?.dateTime ?? item.start?.date ?? ""), end: String(item.end?.dateTime ?? item.end?.date ?? ""), status: String(item.status ?? "confirmed"), htmlLink: typeof item.htmlLink === "string" ? item.htmlLink : undefined }));
}

export async function createGoogleCalendarEvent(input: { accessToken: string; event: CalendarEventInput; idempotencyKey: string }, request: Fetch = fetch): Promise<CalendarEventSummary> {
  const event = validateCalendarEventInput(input.event);
  const eventId = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
  const response = await request(`${GOOGLE_CALENDAR_API}/calendars/primary/events`, {
    method: "POST",
    headers: { ...bearer(input.accessToken), "content-type": "application/json" },
    body: JSON.stringify({ id: eventId, summary: event.summary, description: event.description, location: event.location, start: { dateTime: new Date(event.start).toISOString(), timeZone: event.timeZone }, end: { dateTime: new Date(event.end).toISOString(), timeZone: event.timeZone } }),
  });
  const body = await readJson(response);
  if (!response.ok && response.status !== 409) throw new Error(`Google Calendar event creation failed (${response.status})`);
  if (response.status === 409) return { id: eventId, summary: event.summary, start: event.start, end: event.end, status: "already_exists" };
  return { id: String(body.id), summary: String(body.summary ?? event.summary), start: String(body.start?.dateTime ?? body.start?.date ?? event.start), end: String(body.end?.dateTime ?? body.end?.date ?? event.end), status: String(body.status ?? "confirmed"), htmlLink: typeof body.htmlLink === "string" ? body.htmlLink : undefined };
}

export async function watchGoogleCalendar(input: { accessToken: string; webhookUrl: string; channelId: string; channelToken: string; expiration: number }, request: Fetch = fetch) {
  const response = await request(`${GOOGLE_CALENDAR_API}/calendars/primary/events/watch`, { method: "POST", headers: { ...bearer(input.accessToken), "content-type": "application/json" }, body: JSON.stringify({ id: input.channelId, type: "web_hook", address: input.webhookUrl, token: input.channelToken, expiration: String(input.expiration) }) });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Google Calendar watch failed (${response.status})`);
  return { channelId: String(body.id), resourceId: String(body.resourceId), expiration: Number(body.expiration ?? input.expiration) };
}

function parseTokenResponse(body: any, fallbackRefreshToken: string | undefined): GoogleTokenBundle {
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("Google token response is incomplete");
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefreshToken;
  if (!refreshToken) throw new Error("Google did not return a refresh token; revoke prior consent and reconnect");
  return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1_000, tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer", scope: typeof body.scope === "string" ? body.scope : GOOGLE_CALENDAR_SCOPE };
}

async function readJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return {}; }
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
