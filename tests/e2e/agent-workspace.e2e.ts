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
  await expect(page.getByText(/recorded locally/i)).toBeVisible();
  await expect(page.getByText(/intentionally blocked/i)).toBeVisible();
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

test("health endpoint reports provider readiness without secret values", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, application: "up" });
  expect(body.readiness.missing).toContain("CONVEX_DEPLOYMENT");
  expect(body.readiness.missing).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "MODEL_INPUT_RWF_PER_MILLION", "MODEL_OUTPUT_RWF_PER_MILLION"]));
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
