import { expect, test } from "@playwright/test";

test("recalculates a bounded quote as task requirements change", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Know the cost/i })).toBeVisible();
  const quoteRange = page.locator(".range");
  const initialQuote = await quoteRange.textContent();

  await page.getByRole("button", { name: /Create a deliverable/i }).click();
  await page.getByLabel("Quality").selectOption("expert");
  await page.getByLabel("Attached files").fill("-3");
  await expect(page.getByLabel("Attached files")).toHaveValue("0");
  await page.getByLabel("Attached files").fill("4");
  await page.getByLabel("Includes browser or app work").check();

  await expect(quoteRange).not.toHaveText(initialQuote ?? "");
  await expect(page.getByText("Never exceeds without approval")).toBeVisible();
  await page.getByRole("button", { name: /Reserve task cap/i }).click();
  await expect(page.getByText(/Sign in to reserve a task cap/i)).toBeVisible();
});

test("signs up, bootstraps a workspace, and reserves a real task cap in Convex", async ({ page }) => {
  const email = `e2e-${Date.now()}@circuitagent.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("E2E Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/'s workspace/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Reserve task cap/i }).click();
  await expect(page.getByText(/persisted in Convex/i)).toBeVisible({ timeout: 15_000 });
});

test("plans multiple coding runs with fair scheduling and valid graphs", async ({ page }) => {
  await page.goto("/#agents");
  const createPlan = page.getByRole("button", { name: /Plan coding run/i });
  await createPlan.click();
  await createPlan.click();

  await expect(page.locator(".run-card")).toHaveCount(2);
  await expect(page.getByText("Active plans").locator("..").getByText("2", { exact: true })).toBeVisible();
  await expect(page.getByText("Fairly scheduled now").locator("..")).toContainText("2 / 4");
  await expect(page.getByText("Graph validation").locator("..")).toContainText("Valid");
  await expect(page.getByText("Execution authority").locator("..")).toContainText("Blocked");
  await expect(page.getByText(/does not claim that an agent has executed work/i)).toHaveCount(0);
});

test("compiles research, writing, and operations into distinct capability graphs", async ({ page }) => {
  await page.goto("/#agents");

  await page.getByRole("button", { name: /Research a decision/i }).click();
  await page.getByRole("button", { name: /Plan research run/i }).click();
  await expect(page.getByText("Gather and validate primary sources")).toBeVisible();
  await expect(page.getByText("Web research", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Create a deliverable/i }).click();
  await page.getByRole("button", { name: /Plan writing run/i }).click();
  await expect(page.getByText("Create the first deliverable")).toBeVisible();

  await page.getByRole("button", { name: /Run work operations/i }).click();
  await page.getByRole("button", { name: /Plan operations run/i }).click();
  await expect(page.getByText("Execute the approved external action")).toBeVisible();
  await expect(page.getByText("External operations", { exact: true })).toBeVisible();
});

test("previews multi-app daily workflows without faking provider connections", async ({ page }) => {
  await page.goto("/#integrations");
  await expect(page.getByRole("heading", { name: /Many apps. One controlled workflow/i })).toBeVisible();
  await expect(page.locator(".connector-card")).toHaveCount(8);
  await expect(page.getByText("Not connected", { exact: true })).toHaveCount(8);
  await expect(page.getByText(/No card above represents a simulated connection/i)).toBeVisible();

  await page.getByLabel("Daily workflow").selectOption("project-update");
  await expect(page.getByText("Read project notes")).toBeVisible();
  await expect(page.getByText("Post approved update")).toBeVisible();
  await expect(page.getByText("Approval required", { exact: true })).toHaveCount(2);
});

test("health endpoint reports provider readiness without secret values", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, application: "up" });
  expect(body.readiness.missing).not.toContain("CONVEX_DEPLOYMENT");
  expect(body.readiness.controlPlane).toBe(true);
  expect(typeof body.readiness.codingExecution).toBe("boolean");
  expect(body.readiness.missing.every((name: unknown) => typeof name === "string" && /^[A-Z0-9_]+$/.test(name))).toBe(true);
  expect(JSON.stringify(body)).not.toContain("API_KEY=");
});

test("mobile workflow stays within the viewport and preserves controls", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile geometry check");
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Build or fix software/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reserve task cap/i })).toBeVisible();
  await page.getByRole("button", { name: /Plan coding run/i }).click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
