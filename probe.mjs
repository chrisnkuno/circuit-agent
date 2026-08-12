import { chromium } from "playwright";

console.log("STEP launch");
const launchPromise = chromium.launch({
  executablePath: "C:/Users/ineza/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("launch timeout")), 45000));
const browser = await Promise.race([launchPromise, guard]);
console.log("STEP launched");
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
console.log("STEP newPage");
page.setDefaultTimeout(8000);
try {
  console.log("STEP goto");
  await page.goto("http://127.0.0.1:3100/", { waitUntil: "domcontentloaded", timeout: 25000 });
  console.log("STEP loaded");
  await page.waitForTimeout(3000);
  console.log("STEP waited");
  const title = await page.title();
  console.log("TITLE:", title);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log("OVERFLOW:", overflow);
  await page.screenshot({ path: "probe-top.png" });
  console.log("STEP screenshot done");
} catch (err) {
  console.log("ERR:", String(err).slice(0, 400));
} finally {
  await browser.close();
  console.log("STEP closed");
}
