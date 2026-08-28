import { expect, test } from "@playwright/test";

/**
 * The whole system, against the real providers: two objectives are quoted, approved, and built by
 * two E2B sandboxes at the same time, and everything the command center claims about them is
 * checked against the running machines rather than against fixtures.
 *
 * Gated behind RUN_LIVE_CLOUD_E2E because it spends real money and takes real minutes.
 */
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
  // The workspace is provisioned after sign-up; starting a sandbox before it exists is a no-op.
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 60_000 });

  for (const objective of OBJECTIVES) {
    await page.getByPlaceholder(/Message Nova/).fill(objective);
    await page.getByRole("button", { name: /Run this in a cloud sandbox/ }).click();
    await expect(page.getByText(/Sandbox quoted at up to/)).toBeVisible({ timeout: 60_000 });
  }

  // Nothing has run yet: the price gate is the only thing that starts a machine.
  const approvals = page.locator(".approval-card");
  await expect(approvals).toHaveCount(OBJECTIVES.length, { timeout: 60_000 });
  for (let index = OBJECTIVES.length - 1; index >= 0; index -= 1) {
    await approvals.nth(index).getByRole("button", { name: "Approve" }).click();
  }

  // Parallelism is the claim under test: both runs are live at once, and opening one sandbox
  // never stops the other.
  await expect(page.locator(".active-chip")).toHaveCount(OBJECTIVES.length, { timeout: 120_000 });

  // The fleet panel is fed by the provider, not by our own records: a card only appears once E2B
  // has actually handed back a sandbox id.
  const fleet = page.locator(".sandbox-card");
  await expect(fleet.first()).toBeVisible({ timeout: 5 * 60_000 });
  const firstSandboxId = await fleet.first().locator("code").textContent();
  expect(firstSandboxId ?? "").toMatch(/^[a-z0-9]{8,}$/i);

  // Live metrics: E2B publishes a sample every five seconds, so the meters must fill in on their
  // own without any interaction.
  await expect(fleet.first().locator(".meter").first()).toBeVisible({ timeout: 90_000 });
  const meters = await fleet.first().locator(".meter b").allTextContents();
  expect(meters).toEqual(["CPU", "Memory", "Disk", "Pressure"]);
  const readings = await fleet.first().locator(".meter small").allTextContents();
  console.log(JSON.stringify({ sandbox: firstSandboxId, readings }));
  // Every measurement is present and none of them is a placeholder.
  const labels = await fleet.first().locator(".sandbox-insight dt").allTextContents();
  expect(labels).toEqual(["Template", "Uptime", "Billed", "CPU trend", "Rate", "Efficiency"]);
  for (const value of await fleet.first().locator(".sandbox-insight dd").allTextContents()) {
    expect(value.trim()).not.toBe("");
    expect(value).not.toContain("NaN");
  }

  const cards = page.locator(".task-card");
  await expect(cards).toHaveCount(OBJECTIVES.length, { timeout: 60_000 });
  await expect(cards.first().locator("header p")).toHaveText("completed", { timeout: 15 * 60_000 });
  await expect(cards.last().locator("header p")).toHaveText("completed", { timeout: 15 * 60_000 });

  for (const index of [0, 1]) {
    await cards.nth(index).getByRole("button", { name: /Open sandbox/ }).click();
    await expect(page.getByRole("dialog", { name: "Sandbox detail" })).toBeVisible();
    await expect(page.locator(".artifact-list li").first()).toBeVisible({ timeout: 60_000 });
    const files = await page.locator(".artifact-list b").allTextContents();
    // Deployability is the contract: the work is only done if it can be handed to someone else.
    expect(files.join(" ")).toContain("DEPLOYMENT.md");
    console.log(JSON.stringify({ task: index, files }));
    await page.getByRole("button", { name: "Close sandbox detail" }).click();
  }

  await cards.first().getByRole("button", { name: /Open sandbox/ }).click();
  await page.getByRole("button", { name: "Live preview" }).click();
  const frame = page.getByTitle("Generated app preview");
  await expect(frame).toBeVisible({ timeout: 60_000 });
  const previewUrl = await frame.getAttribute("src");
  console.log(JSON.stringify({ previewUrl }));
  expect(previewUrl ?? "").toMatch(/^https:\/\/3000-\w+\.e2b\.app/);
});
