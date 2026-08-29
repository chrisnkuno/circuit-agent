import { expect, test, type Page } from "@playwright/test";

/**
 * Does the in-app live-preview iframe actually render the built app, styled — not just point at a
 * URL that happens to 200? Builds one small styled page, opens the drawer, starts the preview, and
 * checks: the E2B response headers (X-Frame-Options / CSP can silently blank an iframe), whether
 * the framed document's own stylesheets and scripts loaded, and how the same URL renders as a
 * top-level page for comparison.
 *
 * Gated behind RUN_PREVIEW_CHECK. Spends real money.
 */
test("the live-preview iframe renders the built app with its styles", async ({ page, context }) => {
  test.skip(process.env.RUN_PREVIEW_CHECK !== "true", "explicit live preview diagnostic only");
  test.setTimeout(15 * 60_000);
  const mark = Date.now();
  const note = (line: string) => console.log(`[${((Date.now() - mark) / 1000).toFixed(1)}s] ${line}`);

  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Preview Check");
  await page.getByPlaceholder("Email").fill(`preview-${Date.now()}@circuitnova.test`);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 120_000 });
  note("workspace ready");

  await page.getByPlaceholder(/Message Nova/).fill(
    "Build a one-page coffee shop landing site with a bold hero, opening hours, three menu highlights and a contact section. Style it with a CSS file — distinct colours, real layout, not default browser styles. Use sample data. Include DEPLOYMENT.md and pass the production build.",
  );
  await page.getByRole("button", { name: /Run this in a cloud sandbox/ }).click();
  await expect(page.locator(".composer-notice")).toContainText(/Started|Quoted/, { timeout: 90_000 });
  note(`notice: ${(await page.locator(".composer-notice").innerText()).trim()}`);

  // Clear any price gate, then wait for the build to finish.
  for (let pass = 0; pass < 10; pass += 1) {
    const approve = page.locator(".approval-card").first().getByRole("button", { name: "Approve" });
    if (!(await approve.isVisible().catch(() => false))) break;
    await approve.click();
    await page.waitForTimeout(1_500);
  }
  const card = page.locator(".task-card").first();
  await expect(card.locator("header p")).toHaveText(/completed|blocked/, { timeout: 12 * 60_000 });
  note(`task state: ${await card.locator("header p").textContent()}`);

  // Open the sandbox drawer and start the preview.
  await card.getByRole("button", { name: /Open sandbox|view output/i }).click().catch(async () => {
    await card.locator("button.view-output").click();
  });
  await expect(page.locator(".output-panel, .output-backdrop, .live-preview, .output-actions").first()).toBeVisible({ timeout: 30_000 });

  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("e2b.app")) failed.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText}`);
  });
  const e2bResponses: Array<{ url: string; status: number; type: string | undefined }> = [];
  page.on("response", (response) => {
    if (response.url().includes("e2b.app")) e2bResponses.push({ url: response.url(), status: response.status(), type: response.headers()["content-type"] });
  });

  await page.getByRole("button", { name: /Live preview/ }).click({ timeout: 30_000 });
  const frame = page.locator(".live-preview iframe");
  await expect(frame).toBeVisible({ timeout: 3 * 60_000 });
  const previewUrl = (await frame.getAttribute("src")) ?? "";
  note(`PREVIEW_URL ${previewUrl}`);
  expect(previewUrl).toMatch(/^https:\/\/3000-\w+\.e2b\.app/);

  // 1. Raw response headers — the things that silently blank or unstyle an iframe.
  const res = await page.request.get(previewUrl, { timeout: 30_000 });
  const headers = res.headers();
  note(`HTTP ${res.status()} | x-frame-options=${headers["x-frame-options"] ?? "(none)"} | content-security-policy=${(headers["content-security-policy"] ?? "(none)").slice(0, 200)} | content-type=${headers["content-type"]}`);
  const html = await res.text();
  const cssLinks = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)].map((m) => m[0]);
  const styleTags = (html.match(/<style[\s>]/gi) ?? []).length;
  note(`HTML ${html.length}B | <link stylesheet> x${cssLinks.length} | <style> x${styleTags}`);
  cssLinks.slice(0, 5).forEach((link) => note(`  css: ${link.slice(0, 160)}`));

  // 2. Wait for the iframe to load, then inspect the framed document directly.
  await page.waitForTimeout(8_000);
  const handle = await frame.elementHandle();
  const framedFrame = await handle?.contentFrame();
  const framedReport = framedFrame
    ? await framedFrame.evaluate(() => {
        const sheets = Array.from(document.styleSheets).map((s) => {
          try {
            return { href: s.href, rules: s.cssRules?.length ?? -1 };
          } catch (error) {
            return { href: s.href, rules: -1, error: (error as Error).name };
          }
        });
        const bodyStyle = getComputedStyle(document.body);
        return {
          title: document.title,
          bodyText: (document.body.innerText || "").slice(0, 200),
          childCount: document.body.childElementCount,
          styleSheets: sheets,
          bodyBg: bodyStyle.backgroundColor,
          bodyFont: bodyStyle.fontFamily,
          hasLinkTags: document.querySelectorAll('link[rel="stylesheet"]').length,
        };
      }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    : { error: "iframe has no contentFrame (cross-origin blocked or not loaded)" };
  note(`FRAMED ${JSON.stringify(framedReport)}`);

  // 3. Same URL as a top-level page, for comparison.
  const top = await context.newPage();
  await top.goto(previewUrl, { waitUntil: "load", timeout: 60_000 });
  await top.waitForTimeout(4_000);
  const topReport = await top.evaluate(() => ({
    title: document.title,
    childCount: document.body.childElementCount,
    styleSheets: Array.from(document.styleSheets).map((s: CSSStyleSheet) => ({ href: s.href, rules: (() => { try { return s.cssRules?.length ?? -1; } catch { return -1; } })() })),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyFont: getComputedStyle(document.body).fontFamily,
  }));
  note(`TOPLEVEL ${JSON.stringify(topReport)}`);
  await top.close();

  note(`E2B responses (${e2bResponses.length}): ${JSON.stringify(e2bResponses.slice(0, 20))}`);
  note(`E2B failed requests (${failed.length}): ${JSON.stringify(failed.slice(0, 20))}`);

  // The actual assertions: the framed doc rendered real content and at least one working stylesheet.
  expect(framedReport).not.toHaveProperty("error");
  const report = framedReport as Extract<typeof framedReport, { childCount: number }>;
  expect(report.childCount, "framed <body> has rendered elements").toBeGreaterThan(0);
  const workingSheets = report.styleSheets.filter((s) => s.rules > 0).length;
  expect(workingSheets, "framed document has at least one stylesheet with rules").toBeGreaterThan(0);
});
