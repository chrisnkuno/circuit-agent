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
  const email = `e2e-${Date.now()}@circuitnova.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("E2E Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });
  // The workspace name is no longer printed beside the identity — it became a readiness dot
  // (see components/auth-panel.tsx), so readiness is what this waits on.
  await expect(page.locator(".auth-workspace-dot.auth-workspace-ready")).toBeVisible({ timeout: 15_000 });

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

/**
 * The money gate: a real coding command must price the work and stop. This test deliberately
 * never accepts the quote, so it exercises the whole path without spending anything — which is
 * also precisely the guarantee being asserted.
 */
test("quotes a real coding run and executes nothing until the price is accepted", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const email = `gate-${Date.now()}@circuitnova.test`;
  await page.goto("/terminal");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Gate Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("CHANNELS")).toBeVisible({ timeout: 30_000 });

  const input = page.getByLabel("Terminal command input");
  await input.fill("run coding create a file named quote-check.txt containing the word quoted");
  await input.press("Enter");

  const body = page.locator(".terminal-body");
  await expect(body).toContainText("hard cap", { timeout: 30_000 });
  await expect(body).toContainText("nothing is charged and no worker has started");

  // The gate must name the amount it is asking for, not just that it wants approval.
  const approval = page.locator(".terminal-approval");
  await expect(approval).toContainText("never above", { timeout: 20_000 });

  // The amount must survive truncation. Two things guarantee that: the request always leads
  // with the price (so a clipped tail only ever costs the objective), and on a phone the row
  // wraps instead of clipping — without that it read "Approve to s…", asking someone to
  // authorise a spend they could not see.
  await approval.scrollIntoViewIfNeeded();
  const priceRow = approval.locator(".terminal-approval-text");
  // \s, not a literal space: Intl currency formatting separates "RWF" from the digits
  // with a non-breaking space.
  await expect(priceRow).toContainText(/^Approve to spend RWF\s[\d,]+/);
  if (testInfo.project.name.includes("mobile")) {
    await expect(priceRow).toHaveCSS("white-space", "normal");
    const clipped = await priceRow.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(clipped, "approval text clipped on a phone").toBe(false);
  }

  // Nothing may execute while the quote is unanswered.
  await page.waitForTimeout(6_000);
  await expect(body).not.toContainText("claimed by a worker");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * Stopping a task from the task list. Uses a quoted-but-unaccepted task, which is stoppable and
 * costs nothing to create, so this covers the control without spending on a run.
 */
test("stops a task from the task list", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `stop-${Date.now()}@circuitnova.test`;
  await page.goto("/terminal");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Stop Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("CHANNELS")).toBeVisible({ timeout: 30_000 });

  const input = page.getByLabel("Terminal command input");
  await input.fill("run coding create a file named stoppable.txt containing the word stop");
  await input.press("Enter");

  const card = page.locator(".task-card").first();
  await expect(card).toContainText("awaiting approval", { timeout: 30_000 });

  await card.getByRole("button", { name: "Stop" }).click();

  // The stopped task moves out of "Active", so the list must follow it rather than let the
  // card a person just acted on silently disappear.
  const stopped = page.locator(".task-card").first();
  await expect(stopped).toContainText("cancelled", { timeout: 30_000 });
  // A stopped task is terminal, so it must no longer offer to be stopped again.
  await expect(stopped.getByRole("button", { name: "Stop" })).toHaveCount(0);
  // ...and its pending cost gate must be withdrawn rather than left decidable.
  await expect(page.locator(".terminal-approval")).toHaveCount(0, { timeout: 30_000 });
});
