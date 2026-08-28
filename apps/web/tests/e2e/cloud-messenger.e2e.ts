import { expect, test } from "@playwright/test";

async function signUp(page: import("@playwright/test").Page) {
  const email = `messenger-${Date.now()}-${Math.random().toString(36).slice(2)}@circuitnova.test`;
  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Messenger Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  // The cloud rail is display:none on mobile, so it has no ARIA role there. Gate on the composer,
  // which every viewport renders, and assert the rail from within the view that shows it.
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 20_000 });
}

test("mobile messenger exposes chats, Nova, activity, options, theme, and commands without overflow", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile acceptance");
  await signUp(page);
  await expect(page.getByRole("navigation", { name: "Messenger views" })).toBeVisible();
  await page.getByRole("button", { name: "Nova options" }).click();
  await expect(page.getByRole("dialog", { name: "Nova options" })).toBeVisible();
  await page.getByLabel("Provider").selectOption("deployment");
  await page.getByRole("button", { name: "build", exact: true }).click();
  await page.getByRole("button", { name: "Save options" }).click();
  await page.getByPlaceholder(/Message Nova/).fill("/tasks");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Cloud activity" })).toBeVisible();
  await page.getByRole("button", { name: "Nova", exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("desktop messenger presents all three live panes", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "desktop acceptance");
  await signUp(page);
  await expect(page.locator(".conversation-rail")).toBeVisible();
  await expect(page.locator(".chat-pane")).toBeVisible();
  await expect(page.locator(".cloud-rail")).toBeVisible();
});
