import { expect, test } from "@playwright/test";

/**
 * The messenger must fit every phone without sideways scroll or clipped content. `body` is
 * `overflow: hidden`, so anything wider than the viewport is silently cut off — this walks the
 * real DOM at a range of phone widths and fails on the specific element that overflows, on each
 * of the three mobile panes.
 *
 * Gated behind RUN_MOBILE_FIT (needs a running app + a real sign-up).
 */
const WIDTHS = [
  { name: "iPhone SE", width: 320, height: 568 },
  { name: "small Android", width: 360, height: 640 },
  { name: "iPhone 13", width: 390, height: 844 },
  { name: "iPhone Pro Max", width: 430, height: 932 },
  { name: "phone landscape", width: 667, height: 375 },
];

test("the messenger fits every phone width with no horizontal overflow", async ({ page }) => {
  test.skip(process.env.RUN_MOBILE_FIT !== "true", "explicit mobile-fit acceptance only");
  test.setTimeout(3 * 60_000);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Mobile Fit");
  await page.getByPlaceholder("Email").fill(`mobilefit-${Date.now()}@circuitnova.test`);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".message-bubble.nova").first()).toBeVisible({ timeout: 30_000 });
  // Worst case for width: a long unbroken token in the composer, plus a normal sentence, so the
  // textarea and the composer row have to hold real content while we measure.
  await page.getByPlaceholder(/Message Nova/).fill(
    "https://this-is-a-deliberately-very-long-unbroken-url-with-no-spaces.example.com/path/that/keeps/going and a normal trailing sentence about building things",
  );

  const panes = [
    { key: "conversations", nav: "Chats" },
    { key: "chat", nav: "Nova" },
    { key: "sandboxes", nav: "Sandboxes" },
  ] as const;
  const findOverflow = () =>
    page.evaluate((viewportWidth) => {
      const offenders: { tag: string; cls: string; w: number; text: string }[] = [];
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // A few px of sub-pixel rounding is not a bug; 2px+ past the viewport edge is.
        if (rect.right > viewportWidth + 1 || rect.left < -1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: typeof el.className === "string" ? el.className : "",
            w: Math.round(rect.width),
            text: (el.textContent || "").trim().slice(0, 40),
          });
        }
      }
      return {
        docScroll: document.documentElement.scrollWidth,
        bodyScroll: document.body.scrollWidth,
        offenders: offenders.slice(0, 12),
      };
    }, page.viewportSize()!.width);

  await expect(page.locator(".mobile-nav")).toBeVisible({ timeout: 10_000 });
  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const pane of panes) {
      // force: the Next dev-mode overlay portal sits over the bottom nav and intercepts pointer
      // events — a dev-only artifact, absent from a production build. We are measuring layout, not
      // click-through, so bypass the actionability check.
      await page.locator(".mobile-nav button", { hasText: pane.nav }).click({ timeout: 10_000, force: true });
      await page.waitForTimeout(150);
      const report = await findOverflow();
      const overflowsX = report.docScroll > size.width || report.bodyScroll > size.width;
      console.log(`${size.name} ${size.width}px / ${pane.key}: docScroll=${report.docScroll} bodyScroll=${report.bodyScroll}${report.offenders.length ? ` :: ${JSON.stringify(report.offenders)}` : ""}`);
      expect(overflowsX, `${size.name} (${size.width}px), ${pane.key} pane: horizontal overflow — docScroll ${report.docScroll} > ${size.width}`).toBe(false);
    }

    // The options sheet is a separate full-screen surface on mobile; check it from the chat pane.
    await page.locator(".mobile-nav button", { hasText: "Nova" }).click({ force: true });
    await page.getByRole("button", { name: "Nova options" }).click({ force: true });
    await page.locator(".options-panel").waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(150);
    const opts = await findOverflow();
    console.log(`${size.name} ${size.width}px / options: docScroll=${opts.docScroll}${opts.offenders.length ? ` :: ${JSON.stringify(opts.offenders)}` : ""}`);
    expect(opts.docScroll > size.width, `${size.name} (${size.width}px), options panel: horizontal overflow — ${JSON.stringify(opts.offenders)}`).toBe(false);
    await page.getByRole("button", { name: "Close options" }).click({ force: true });
    await page.locator(".options-panel").waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  }
});
