import { expect, test } from "@playwright/test";

/**
 * The exchange that failed in production, replayed against the real model and real sandboxes.
 *
 * A person answered a clarifying question, Nova proposed a concrete build and quoted it, the
 * person said "go ahead and start" — and nothing ran, because build intent was read one message
 * at a time and neither message carried the request alone. Nova then explained that it had no
 * execution control, which was not true.
 */
test("a short yes to Nova's own proposal starts the sandbox", async ({ page }) => {
  test.skip(process.env.RUN_CHAT_FEEL !== "true", "explicit live walkthrough only");
  test.setTimeout(10 * 60_000);
  const mark = Date.now();
  const note = (line: string) => console.log(`[${((Date.now() - mark) / 1000).toFixed(1)}s] ${line}`);

  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Acceptance Runner");
  await page.getByPlaceholder("Email").fill(`accept-${Date.now()}@circuitnova.test`);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 60_000 });

  const composer = page.getByPlaceholder(/Message Nova/);
  const bubbles = page.locator(".message-bubble.nova");
  const send = page.getByRole("button", { name: "Send message" });

  // 1. The vague answer that names an artifact but asks for nothing. This must NOT spend money.
  await composer.fill("a simple api of your choosing");
  await send.click();
  await expect(bubbles).toHaveCount(2, { timeout: 90_000 });
  await expect.poll(async () => (await bubbles.last().locator(".typing").count()) === 0, { timeout: 150_000 }).toBe(true);
  const proposal = await bubbles.last().innerText();
  note(`Nova proposed: ${JSON.stringify(proposal.slice(0, 320))}`);

  // 2. The two-word acceptance that used to do nothing at all.
  await composer.fill("go ahead and start");
  await send.click();
  await expect(bubbles).toHaveCount(3, { timeout: 90_000 });
  await expect.poll(async () => (await bubbles.last().locator(".typing").count()) === 0, { timeout: 150_000 }).toBe(true);
  const answer = await bubbles.last().innerText();
  note(`Nova answered: ${JSON.stringify(answer.slice(0, 320))}`);

  // The refusal that started all this must be gone.
  expect(answer.toLowerCase()).not.toContain("no cloud execution control");
  expect(answer.toLowerCase()).not.toContain("execution control is available");
  expect(answer.toLowerCase()).not.toMatch(/i can'?t start/);

  // And a sandbox must actually exist for it.
  const fleet = page.locator(".sandbox-card");
  await expect(fleet.first()).toBeVisible({ timeout: 120_000 });
  note(`fleet card: ${JSON.stringify(await fleet.first().locator("code").textContent())} in state ${JSON.stringify(await fleet.first().locator(".run-state").textContent())}`);
  await expect(page.locator(".workspace-tab")).toHaveCount(2, { timeout: 120_000 });
  note("a tab exists for the accepted build");
});
