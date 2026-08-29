import { expect, test, type Page } from "@playwright/test";

/**
 * Ten realistic asks driven through the real chat UI against real providers.
 *
 * An acceptance campaign, not a unit test: it deliberately never aborts on a single task, because
 * the question it answers is "which kinds of request actually work end to end", and a run that
 * stops at task three cannot answer that. Every outcome is recorded and printed as one report.
 *
 * Task 1 runs alone and is taken all the way through the parts a user actually touches after a
 * build: the live preview iframe, how long that sandbox survives, and downloading the work. It
 * goes first because a sandbox is short-lived — by the time ten builds have finished, the early
 * machines are long gone, so the preview must be exercised on a fresh one.
 *
 * Gated behind RUN_TEN_TASK_CAMPAIGN: it starts real E2B sandboxes and spends real money.
 */

type Outcome = { name: string; submitted: boolean; notice: string | null; terminal: string; detail?: string };

const WEB_APP = {
  name: "expense-tracker (full web app)",
  objective: "Build an expense tracker page showing expenses by category with totals, using sample data.",
};

/** Short objectives on purpose: a plan must fit the single-step output budget (~32K tokens). */
const REST = [
  { name: "coffee-landing", objective: "Build a one-page coffee shop landing site with hours, menu highlights and a contact section, using sample data." },
  { name: "todo-app", objective: "Build a to-do list page where items can be added and checked off, using sample starting items." },
  { name: "invoice-dashboard", objective: "Build an invoice dashboard page listing customers with totals and paid/overdue badges, using sample data." },
  { name: "csv-validator", objective: "Create a Python command-line tool that validates a sales CSV and writes summary.json, with tests." },
  { name: "markdown-cli", objective: "Create a Python command-line tool that converts a Markdown file to HTML, with tests and a README." },
  { name: "webhook-api", objective: "Build a Node.js webhook inspection API with POST /events, GET /events and GET /health, with tests." },
  { name: "url-shortener", objective: "Build a Node.js URL shortener API with POST /links and GET /:code, in-memory storage and tests." },
  { name: "password-strength", objective: "Create a Node.js password strength checking module with a scoring function and unit tests." },
  { name: "temperature-cli", objective: "Create a Python command-line tool that converts between Celsius and Fahrenheit, with tests." },
];

async function submit(page: Page, objective: string): Promise<string | null> {
  await page.getByPlaceholder(/Message Nova/).fill(objective);
  await page.getByRole("button", { name: /Run this in a cloud sandbox/ }).click();
  const notice = page.locator(".composer-notice").first();
  await expect(notice).toContainText(/Started|Quoted at up to/, { timeout: 90_000 });
  return (await notice.textContent())?.trim().slice(0, 140) ?? null;
}

/** Price gate: only quotes above the automation ceiling produce a card. */
async function clearApprovals(page: Page): Promise<void> {
  for (let pass = 0; pass < 15; pass += 1) {
    const approve = page.locator(".approval-card").first().getByRole("button", { name: "Approve" });
    if (!(await approve.isVisible().catch(() => false))) return;
    await approve.click();
    await page.waitForTimeout(1_500);
  }
}

async function waitForQuiet(page: Page, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const busy = await page.locator(".task-dot.running, .task-dot.queued").count();
    if (busy === 0) return;
    await page.waitForTimeout(15_000);
  }
}

test("ten real asks through the chat UI, with preview, longevity and download", async ({ page }) => {
  test.skip(process.env.RUN_TEN_TASK_CAMPAIGN !== "true", "explicit live-provider acceptance only");
  test.setTimeout(50 * 60_000);
  const outcomes: Outcome[] = [];
  const email = `campaign-${Date.now()}@circuitnova.test`;

  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Campaign Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 120_000 });
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  console.log(`CAMPAIGN_ACCOUNT ${email}`);

  // ---- task 1: the full web app, alone, so its sandbox is fresh for the preview -------------
  const notice = await submit(page, WEB_APP.objective);
  console.log(`SUBMITTED ${WEB_APP.name} :: ${notice}`);
  await clearApprovals(page);
  await waitForQuiet(page, 9 * 60_000);
  const webAppDone = await page.locator(".task-dot.completed").count();
  outcomes.push({ name: WEB_APP.name, submitted: true, notice, terminal: webAppDone > 0 ? "completed" : "failed-or-timeout" });
  console.log(`TASK1_STATE completed_dots=${webAppDone}`);

  // ---- live preview iframe ------------------------------------------------------------------
  let previewUrl: string | null = null;
  try {
    // Preview and download both live inside the sandbox drawer. The fleet's own Preview button
    // only exists while a card is live, so the durable route is the task card's "Open sandbox".
    await page.locator(".task-card").first().locator("button.view-output").click({ timeout: 30_000 });
    await expect(page.locator(".output-actions")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Live preview/ }).click({ timeout: 30_000 });
    const frame = page.locator(".live-preview iframe");
    await expect(frame).toBeVisible({ timeout: 120_000 });
    previewUrl = await frame.getAttribute("src");
    console.log(`PREVIEW_URL ${previewUrl}`);
    expect(previewUrl ?? "").toMatch(/^https:\/\/3000-\w+\.e2b\.app/);
  } catch (error) {
    console.log(`PREVIEW_FAILED ${(error as Error).message.slice(0, 200)}`);
  }

  // ---- how long that sandbox actually stays reachable ---------------------------------------
  if (previewUrl) {
    const started = Date.now();
    let lastOk = 0;
    let lastStatus = 0;
    for (let tick = 0; tick < 12; tick += 1) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      try {
        const res = await page.request.get(previewUrl, { timeout: 20_000 });
        lastStatus = res.status();
        if (res.ok()) lastOk = elapsed;
        console.log(`LONGEVITY t=${elapsed}s status=${lastStatus}`);
        if (!res.ok() && res.status() >= 500) break;
      } catch (error) {
        console.log(`LONGEVITY t=${elapsed}s unreachable :: ${(error as Error).message.slice(0, 90)}`);
        break;
      }
      await page.waitForTimeout(20_000);
    }
    console.log(`LONGEVITY_RESULT reachable_for=${lastOk}s last_status=${lastStatus}`);
  }

  // ---- download the work --------------------------------------------------------------------
  try {
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: /Download all output|Download folder/ }).first().click();
    const file = await download;
    const path = await file.path();
    console.log(`DOWNLOAD_OK name=${file.suggestedFilename()} path=${path}`);
  } catch (error) {
    console.log(`DOWNLOAD_FAILED ${(error as Error).message.slice(0, 200)}`);
  }

  // ---- tasks 2-10 ---------------------------------------------------------------------------
  for (const task of REST) {
    try {
      const text = await submit(page, task.objective);
      outcomes.push({ name: task.name, submitted: true, notice: text, terminal: "pending" });
      console.log(`SUBMITTED ${task.name} :: ${text}`);
    } catch (error) {
      outcomes.push({ name: task.name, submitted: false, notice: null, terminal: "submit-failed", detail: (error as Error).message.slice(0, 160) });
      console.log(`SUBMIT_FAILED ${task.name}`);
    }
  }
  await clearApprovals(page);
  await waitForQuiet(page, 30 * 60_000);

  const completed = await page.locator(".task-dot.completed").count();
  const failed = await page.locator(".task-dot.failed").count();
  console.log(`FLEET_SETTLED completed_dots=${completed} failed_dots=${failed}`);
  console.log(`CAMPAIGN_REPORT ${JSON.stringify(outcomes, null, 2)}`);
});
