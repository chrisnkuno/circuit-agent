import { describe, expect, it, vi } from "vitest";
import { buildGoogleAuthorizationUrl, createGoogleCalendarEvent, GOOGLE_CALENDAR_SCOPE, listGoogleCalendarEvents, validateCalendarEventInput } from "./google-calendar";

describe("Google Calendar adapter", () => {
  it("requests narrow offline access with state and PKCE", () => {
    const url = new URL(buildGoogleAuthorizationUrl({ clientId: "client", redirectUri: "https://app.test/callback", state: "state", codeChallenge: "challenge" }));
    expect(url.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("bounds calendar reads and returns sanitized event summaries", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "1", summary: "Planning", start: { dateTime: "2026-08-05T09:00:00Z" }, end: { dateTime: "2026-08-05T10:00:00Z" }, status: "confirmed" }] }), { status: 200 }));
    const events = await listGoogleCalendarEvents({ accessToken: "token", timeMin: "2026-08-05T00:00:00Z", timeMax: "2026-08-06T00:00:00Z", maxResults: 10 }, request as typeof fetch);
    expect(events).toEqual([{ id: "1", summary: "Planning", start: "2026-08-05T09:00:00Z", end: "2026-08-05T10:00:00Z", status: "confirmed" }]);
    expect(String((request.mock.calls as unknown[][])[0][0])).toContain("singleEvents=true");
  });

  it("creates an idempotent provider event and treats a duplicate as success", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 409 }));
    const result = await createGoogleCalendarEvent({ accessToken: "token", idempotencyKey: "intent-1", event: { summary: "Review", start: "2026-08-05T09:00:00Z", end: "2026-08-05T10:00:00Z", timeZone: "Africa/Cairo" } }, request as typeof fetch);
    expect(result.status).toBe("already_exists");
    const body = JSON.parse(String(((request.mock.calls as unknown[][])[0][1] as RequestInit | undefined)?.body));
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects malformed or unbounded event input", () => {
    expect(() => validateCalendarEventInput({ summary: "", start: "bad", end: "bad", timeZone: "" })).toThrow("summary");
    expect(() => validateCalendarEventInput({ summary: "Long", start: "2026-08-01T00:00:00Z", end: "2026-10-01T00:00:00Z", timeZone: "UTC" })).toThrow("31 days");
  });
});
