import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  // Verifies the server answering on that port is actually this app. See the file for why.
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    // A deliberately unusual port. 3000 and 3100 are what every other Next app on a developer's
    // machine already uses, and `reuseExistingServer` below turns a collision into a silent
    // adoption of whatever is listening rather than an error.
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3179",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run dev --hostname 127.0.0.1 --port 3179",
    // Node resolves AAAA before A. On a host whose IPv6 egress is black-holed, every server-side
    // fetch — the auth route's calls to Convex above all — fails with an ETIMEDOUT AggregateError
    // after exhausting the v6 addresses, while curl on the same box succeeds. The symptom is
    // "Authentication failed" at sign-up and a suite that looks broken for reasons that are not
    // in the app.
    env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim() },
    url: "http://127.0.0.1:3179/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
});
