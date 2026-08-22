import { request } from "@playwright/test";

/**
 * Refuses to run the suite against an app that is not this one.
 *
 * `reuseExistingServer` is worth keeping — it turns a repeated local run from a two-minute Next
 * build into an instant one — but it trusts a port, and a port is not an identity. Anything
 * already listening is adopted silently, and the whole suite then measures somebody else's
 * website: every assertion fails, none of them mentions the actual problem, and the obvious
 * reading is that the tests are broken.
 *
 * That is not hypothetical. This suite once ran end to end against an unrelated Next app that
 * happened to hold the port, producing thirteen assertion failures whose real cause was a
 * canonical-host redirect in a different project's middleware.
 *
 * So the server is asked to identify itself before anything is measured. `/api/health` is this
 * app's own route and returns a shape no other app would return by coincidence.
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3179";
  const context = await request.newContext({ baseURL });
  try {
    // Redirects are not followed: a 3xx away from the base URL is itself the symptom, and
    // following it would let a foreign host answer for ours.
    const response = await context.get("/api/health", { maxRedirects: 0 });
    const body = response.status() === 200 ? await response.json().catch(() => null) : null;
    if (!body || body.application !== "up" || typeof body.readiness !== "object") {
      throw new Error(
        [
          `The server at ${baseURL} is not this application.`,
          `GET /api/health answered ${response.status()}${response.headers().location ? ` → ${response.headers().location}` : ""}, not this app's health payload.`,
          "Something else is holding the port. Stop it, or set E2E_BASE_URL to where this app is running.",
        ].join("\n"),
      );
    }
  } finally {
    await context.dispose();
  }
}
