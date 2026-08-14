// One-off layout verification for the Kage home page (mobile viewport).
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(10000);
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 140));
});

const out = {};
try {
  await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4500);
  out.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  out.geometry = await page.evaluate(() => {
    const nav = document.querySelector(".nav");
    const heading = document.querySelector(".hero h1");
    const peek = document.querySelector(".peek");
    const auth = document.querySelector(".nav-auth");
    const navRect = nav?.getBoundingClientRect();
    const headRect = heading?.getBoundingClientRect();
    return {
      navHeight: Math.round(navRect?.height ?? 0),
      headingTop: Math.round(headRect?.top ?? -1),
      headingVisible: headRect ? headRect.height > 0 && headRect.top >= 0 : false,
      peekDisplay: peek ? getComputedStyle(peek).display : "missing",
      authVisible: auth ? getComputedStyle(auth).display !== "none" : false,
    };
  });
  out.headingText = (await page.locator("h1").first().textContent())?.replace(/\s+/g, " ").trim();
  out.taskCards = await page.locator(".task-card").count();
  out.connectorCards = await page.locator(".connector-card").count();
  out.chips = await page.locator(".chip").count();
  out.reserveVisible = await page.getByRole("button", { name: /Reserve task cap/i }).isVisible();
  out.buildOrFixVisible = await page.getByRole("button", { name: /Build or fix software/i }).isVisible();

  const rangeBefore = (await page.locator(".range").textContent())?.trim();
  await page.getByRole("button", { name: /Create a deliverable/i }).first().click();
  await page.waitForTimeout(300);
  const rangeAfter = (await page.locator(".range").textContent())?.trim();
  out.quoteChanged = rangeBefore !== rangeAfter;
  out.taskName = (await page.locator(".task-name").textContent())?.trim();

  const burger = page.locator(".nav-burger");
  out.burgerVisible = await burger.isVisible();
  if (out.burgerVisible) {
    await burger.click();
    await page.waitForTimeout(600);
    out.menuOpen = await page.evaluate(() =>
      document.querySelector(".nav")?.classList.contains("menu-open") &&
      getComputedStyle(document.querySelector(".nav-links")).visibility === "visible");
    await burger.click();
    await page.waitForTimeout(600);
    out.menuClosed = await page.evaluate(() => !document.querySelector(".nav")?.classList.contains("menu-open"));
  }
  await page.screenshot({ path: "mobile-kage-top.png" });
} catch (err) {
  out.fatal = String(err).slice(0, 300);
} finally {
  out.consoleErrors = consoleErrors.slice(0, 8);
  out.consoleErrorCount = consoleErrors.length;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
