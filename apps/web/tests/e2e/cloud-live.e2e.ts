import { expect, test } from "@playwright/test";

const OBJECTIVES = [
  "Build a minimal responsive launch status web app with a project name and three release checks. Include DEPLOYMENT.md and .env.example, and pass the production build.",
  "Build a small responsive uptime summary web app showing three services and their status. Include DEPLOYMENT.md and .env.example, and pass the production build.",
];

test("runs deployable app tasks in parallel in E2B and exposes each one's output", async ({ page }) => {
  test.skip(process.env.RUN_LIVE_CLOUD_E2E !== "true", "explicit live-provider acceptance only");
  test.setTimeout(22 * 60_000);
  const email = `cloud-live-${Date.now()}@circuitnova.test`;
  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Cloud Verification");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  // The workspace is provisioned after sign-up; starting a task before it exists is a no-op.
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 60_000 });

  for (const objective of OBJECTIVES) {
    await page.getByPlaceholder(/Message Nova/).fill(objective);
    await page.getByRole("button", { name: /Start cloud task/ }).click();
    await expect(page.getByText(/Cloud task quoted at up to/)).toBeVisible({ timeout: 60_000 });
  }

  const approvals = page.locator(".approval-card");
  await expect(approvals).toHaveCount(OBJECTIVES.length, { timeout: 60_000 });
  for (let index = OBJECTIVES.length - 1; index >= 0; index -= 1) {
    await approvals.nth(index).getByRole("button", { name: "Approve" }).click();
  }

  // Parallelism is the claim under test: both runs are live at once, and opening one output
  // never stops the other.
  await expect(page.locator(".active-chip")).toHaveCount(OBJECTIVES.length, { timeout: 120_000 });

  const cards = page.locator(".task-card");
  await expect(cards).toHaveCount(OBJECTIVES.length, { timeout: 60_000 });
  await expect(cards.first().locator("header p")).toHaveText("completed", { timeout: 15 * 60_000 });
  await expect(cards.last().locator("header p")).toHaveText("completed", { timeout: 15 * 60_000 });

  for (const index of [0, 1]) {
    await cards.nth(index).getByRole("button", { name: /View live output/ }).click();
    await expect(page.getByRole("dialog", { name: "Task output" })).toBeVisible();
    await expect(page.locator(".artifact-list li").first()).toBeVisible({ timeout: 60_000 });
    const files = await page.locator(".artifact-list b").allTextContents();
    console.log(JSON.stringify({ task: index, files }));
    await page.getByRole("button", { name: "Close output" }).click();
  }

  await cards.first().getByRole("button", { name: /View live output/ }).click();
  await page.getByRole("button", { name: "Live preview" }).click();
  const frame = page.getByTitle("Generated app preview");
  await expect(frame).toBeVisible({ timeout: 60_000 });
  console.log(JSON.stringify({ previewUrl: await frame.getAttribute("src") }));
});
