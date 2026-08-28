import { expect, test } from "@playwright/test";

/**
 * A first-hand read of the chatting experience, against the real model and real sandboxes.
 *
 * Not an assertion suite — a walkthrough that times each step and prints what actually came back,
 * so the experience can be judged rather than assumed. Gated like the other live acceptance.
 */
test("what it is like to use", async ({ page }) => {
  test.skip(process.env.RUN_CHAT_FEEL !== "true", "explicit live walkthrough only");
  test.setTimeout(12 * 60_000);
  const mark = Date.now();
  const since = () => `${((Date.now() - mark) / 1000).toFixed(1)}s`;
  const log: string[] = [];
  const note = (line: string) => { log.push(`[${since()}] ${line}`); console.log(`[${since()}] ${line}`); };

  const email = `feel-${Date.now()}@circuitnova.test`;
  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Feel Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  note("signed up, composer ready");
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 60_000 });
  note("workspace ready");
  note(`suggestions offered: ${JSON.stringify(await page.locator(".suggestion").allTextContents())}`);

  // 1. An ordinary question. This should feel like a chat, not like filing a ticket.
  const composer = page.getByPlaceholder(/Message Nova/);
  await composer.fill("What can you actually do for me? Answer in three short bullets.");
  await page.getByRole("button", { name: "Send message" }).click();
  const bubbles = page.locator(".message-bubble.nova");
  await expect(bubbles).toHaveCount(2, { timeout: 90_000 });
  note("Nova replied to the question");
  await expect.poll(async () => (await bubbles.last().locator(".typing").count()) === 0, { timeout: 150_000 }).toBe(true);
  note(`greeting: ${JSON.stringify((await bubbles.first().innerText()).slice(0, 260))}`);
  note(`answer: ${JSON.stringify((await bubbles.last().innerText()).slice(0, 600))}`);

  // 2. A build request. With the automation ceiling this should start on its own.
  await composer.fill("Build a tiny responsive web app that shows three service statuses. Include DEPLOYMENT.md and .env.example.");
  await page.getByRole("button", { name: /Run this in a cloud sandbox/ }).click();
  await expect(page.locator(".composer-notice")).toContainText(/Started|Quoted/, { timeout: 60_000 });
  note(`quote notice: ${JSON.stringify(await page.locator(".composer-notice").innerText())}`);

  const approvals = page.locator(".approval-card");
  const asked = await approvals.count();
  note(asked > 0 ? "STILL ASKED for approval" : "started without asking");

  await expect(page.locator(".workspace-tab")).toHaveCount(2, { timeout: 180_000 });
  note("a tab appeared for the running sandbox");
  const fleet = page.locator(".sandbox-card");
  await expect(fleet.first()).toBeVisible({ timeout: 60_000 });
  note(`fleet card appeared in state: ${JSON.stringify(await fleet.first().locator(".run-state").textContent())}`);
  note(`sandbox card: ${JSON.stringify(await fleet.first().locator("code").textContent())}`);
  // Meters only exist once E2B has handed back a machine; before that the card says so.
  await expect(fleet.first().locator(".run-state")).not.toHaveText("starting", { timeout: 5 * 60_000 });
  note(`machine ready: ${JSON.stringify(await fleet.first().locator("code").textContent())}`);
  await expect(fleet.first().locator(".meter").first()).toBeVisible({ timeout: 120_000 });
  note(`meters: ${JSON.stringify(await fleet.first().locator(".meter small").allTextContents())}`);

  await page.locator(".workspace-tab").nth(1).click();
  note("switched to the sandbox tab while it works");
  await expect(page.locator(".output-panel.inline")).toBeVisible();

  console.log("\n=== WALKTHROUGH ===\n" + log.join("\n"));
});
