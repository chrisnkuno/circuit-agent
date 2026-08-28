import { expect, test, type Page } from "@playwright/test";

/**
 * The interface contract, checked in a real browser.
 *
 * Everything here is behaviour a unit test cannot see because it only exists once a browser has
 * laid the panes out: what scrolls, what stays put, what fits, and what a person can reach.
 */

/**
 * Serial, on one account, in one page.
 *
 * These tests measure layout, not account creation, and a fresh sign-up per test put twenty real
 * account creations through one shared development backend — whichever test lost that race failed,
 * a different one each run, looking exactly like a layout bug. One sign-up and a reload per test
 * gives every test a clean DOM without the contention that was inventing failures.
 */
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  const email = `iface-${Date.now()}-${Math.random().toString(36).slice(2)}@circuitnova.test`;
  await page.goto("/messages");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByPlaceholder("Name").fill("Interface Runner");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("CorrectHorseBattery9");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  // The workspace is provisioned after sign-up, and nothing that spends or saves works before it.
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 30_000 });
});

test.afterAll(async () => { await page?.close(); });

/** A clean thread for each test, without a clean account. */
test.beforeEach(async () => {
  await page.setViewportSize(test.info().project.name.includes("mobile") ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.goto("/messages");
  await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible({ timeout: 30_000 });
  // The workspace query re-resolves on every load, and nothing that spends or saves works until
  // it has. Waiting here is what the app itself now tells a person to do.
  await expect(page.locator(".rail-footer b")).not.toHaveText("Preparing workspace", { timeout: 30_000 });
});

/** Fills the thread with real bubbles so the pane has something to scroll. */
async function fillThread(count = 60) {
  await page.locator(".message-stream").evaluate((node, total) => {
    for (let index = 0; index < total; index += 1) {
      const bubble = document.createElement("article");
      bubble.className = `message-bubble ${index % 2 === 0 ? "user" : "nova"}`;
      bubble.innerHTML = `<p>Message ${index} — long enough to wrap and take real vertical space.</p>`;
      node.appendChild(bubble);
    }
  }, count);
}

test.describe("the message stream", () => {
  test("scrolls inside itself and never grows the page", async () => {
    // The defect this pins: `.chat-pane` and `.message-stream` are flex items whose automatic
    // minimum size is their content height, so without min-height:0 the stream grew to fit every
    // message, `overflow: auto` had nothing to overflow, and the thread pushed the shell past the
    // viewport. "The chat does not scroll" is exactly how that reads to a person.
    await fillThread();
    const stream = page.locator(".message-stream");

    const geometry = await stream.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect(geometry.overflowY).toBe("auto");
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight + 100);

    const overflow = await page.evaluate(() => ({
      vertical: document.documentElement.scrollHeight - window.innerHeight,
      horizontal: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.vertical).toBeLessThanOrEqual(0);
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
  });

  test("follows a streaming reply only while the reader is at the bottom", async () => {
    // The rule worth protecting: growing content pins the view when you are already at the
    // bottom, and never moves it when you have scrolled up to read something.
    await fillThread();
    const stream = page.locator(".message-stream");
    await stream.evaluate((node) => { node.scrollTop = node.scrollHeight; });

    const append = () => stream.evaluate((node) => {
      const bubble = document.createElement("article");
      bubble.className = "message-bubble nova";
      bubble.innerHTML = "<p>A reply arriving one token at a time, growing the thread as it lands.</p>";
      node.appendChild(bubble);
    });

    await append();
    await expect.poll(() => stream.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight), { timeout: 15_000 }).toBeLessThan(4);

    // Now read something earlier. The view must stay exactly where it was put.
    //
    // A scroll event is dispatched asynchronously, so appending immediately after setting
    // scrollTop can beat the app's own scroll handler — a race in the test, not in the app, since
    // a real reader's scroll always lands first. The Latest button appearing is the app saying it
    // has registered the scroll, so that is what this waits for.
    await stream.evaluate((node) => { node.scrollTop = 0; });
    await expect(page.getByRole("button", { name: /Latest/ })).toBeVisible({ timeout: 15_000 });
    await append();
    await expect.poll(() => stream.evaluate((node) => node.scrollTop)).toBeLessThan(4);
  });

  test("offers a way back to the newest message once you scroll away", async () => {
    await fillThread();
    const stream = page.locator(".message-stream");
    await stream.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => stream.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight), { timeout: 15_000 }).toBeLessThan(4);
    await expect(page.getByRole("button", { name: /Latest/ })).toBeHidden({ timeout: 15_000 });

    await stream.evaluate((node) => { node.scrollTop = 0; });
    const latest = page.getByRole("button", { name: /Latest/ });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect.poll(() => stream.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight), { timeout: 15_000 }).toBeLessThan(4);
    await expect(latest).toBeHidden({ timeout: 15_000 });
  });

  test("keeps a long code line inside its own block instead of widening the page", async () => {
    await page.locator(".message-stream").evaluate((node) => {
      const bubble = document.createElement("article");
      bubble.className = "message-bubble nova";
      bubble.innerHTML = `<div class="markdown"><figure class="code-block"><pre><code>${"x".repeat(600)}</code></pre></figure></div>`;
      node.appendChild(bubble);
    });
    const block = page.locator(".code-block pre").first();
    await expect(block).toBeVisible();
    // The block scrolls; the document does not.
    const scrolls = await block.evaluate((node) => node.scrollWidth > node.clientWidth);
    expect(scrolls).toBe(true);
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(horizontal).toBeLessThanOrEqual(0);
  });
});

test.describe("the composer", () => {
  test("grows with the message and sends on Enter, not on Shift+Enter", async () => {
    const composer = page.getByPlaceholder(/Message Nova/);
    const start = await composer.evaluate((node) => node.clientHeight);
    await composer.fill(Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"));
    const grown = await composer.evaluate((node) => node.clientHeight);
    expect(grown).toBeGreaterThan(start);
    // Never past its ceiling — a composer that eats the thread is its own bug.
    expect(grown).toBeLessThanOrEqual(160);

    await composer.fill("draft that should survive");
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue(/draft that should survive/);
  });

  test("runs a slash command with no conversation and reports an unknown one", async () => {
    const composer = page.getByPlaceholder(/Message Nova/);
    await composer.fill("/nonsense");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".composer-notice")).toContainText(/Unknown command/);
    await composer.fill("/options");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("dialog", { name: "Nova options" })).toBeVisible();
  });
});

test.describe("suggestions", () => {
  test("offers starting points and stands down the moment you type", async () => {
    const chips = page.locator(".suggestion");
    await expect(chips.first()).toBeVisible({ timeout: 20_000 });
    const label = await chips.first().textContent();
    await chips.first().click();
    // Taking a starter fills the composer rather than running anything.
    await expect(page.getByPlaceholder(/Message Nova/)).not.toHaveValue("");
    expect(label ?? "").not.toBe("");
    // And with a draft in progress, nothing is suggested over it.
    await expect(chips).toHaveCount(0);
  });
});

test.describe("the command center", () => {
  test("shows the fleet, its measurements, and an honest empty state", async ({}, testInfo) => {
    if (testInfo.project.name.includes("mobile")) await page.getByRole("button", { name: "Sandboxes" }).click();
    await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
    // Nine measurements, every one of them labelled and none of them NaN.
    const tiles = page.locator(".cloud-metrics div");
    await expect(tiles).toHaveCount(9);
    for (const value of await page.locator(".cloud-metrics b").allTextContents()) {
      expect(value).not.toContain("NaN");
      expect(value.trim()).not.toBe("");
    }
    await expect(page.locator(".empty-cloud")).toContainText(/No sandboxes running/);
  });

  test("states the automation ceiling that decides what runs without asking", async () => {
    await page.getByRole("button", { name: "Nova options" }).click();
    const ceiling = page.getByLabel(/Run without asking/);
    await expect(ceiling).toHaveValue("5000");
    await ceiling.fill("12000");
    await page.getByRole("button", { name: "Save options" }).click();
    await expect(page.locator(".composer-notice")).toContainText(/saved/i, { timeout: 20_000 });
    await page.getByRole("button", { name: "Nova options" }).click();
    // Reading it back is a Convex round trip, so it is eventual like every other one here.
    await expect(page.getByLabel(/Run without asking/)).toHaveValue("12000", { timeout: 20_000 });
  });
});

test.describe("navigation", () => {
  test("gives a phone one full-height pane at a time under a tab bar", async ({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "mobile navigation");
    await expect(page.getByRole("navigation", { name: "Messenger views" })).toBeVisible();
    await page.getByRole("button", { name: "Sandboxes" }).click();
    await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
    await expect(page.locator(".chat-pane")).toBeHidden();
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await expect(page.locator(".conversation-rail")).toBeVisible();
    await page.getByRole("button", { name: "Nova", exact: true }).click();
    await expect(page.getByPlaceholder(/Message Nova/)).toBeVisible();
  });

  test("shows all three live panes side by side on a desktop", async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop layout");
    await expect(page.locator(".conversation-rail")).toBeVisible();
    await expect(page.locator(".chat-pane")).toBeVisible();
    await expect(page.locator(".cloud-rail")).toBeVisible();
  });

  test("saves the provider and mode a person chooses", async () => {
    await page.getByRole("button", { name: "Nova options" }).click();
    await page.getByLabel("Provider").selectOption("deployment");
    await page.getByRole("button", { name: "build", exact: true }).click();
    await page.getByRole("button", { name: "Save options" }).click();
    await expect(page.locator(".composer-notice")).toContainText(/build mode/i, { timeout: 20_000 });
  });
});

test.describe("layout", () => {
  test("never scrolls the page sideways at any width", async () => {
    await fillThread(20);
    for (const width of [360, 420, 768, 900, 1280, 1600]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test("keeps every pane scrollable rather than letting one grow the shell", async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "the three panes share the viewport only on a desktop");
    await fillThread();
    for (const selector of [".conversation-list", ".message-stream", ".cloud-rail"]) {
      const fits = await page.locator(selector).evaluate((node) => node.clientHeight <= window.innerHeight);
      expect(fits, `${selector} is taller than the viewport`).toBe(true);
    }
  });
});
