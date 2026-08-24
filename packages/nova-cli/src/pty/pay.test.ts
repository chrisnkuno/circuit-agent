import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnNova, type NovaProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { startBillingStub, type BillingStub } from "./billing-stub";

/**
 * Paying, in a real terminal, against a real (stub) billing service.
 *
 * The unit tests prove the grammar, the wording and the gateway. This proves the thing they cannot:
 * that `/pay` is reachable from the prompt at all, that no checkout exists until a human answers
 * the question, and that one confirmed top-up creates exactly one payment.
 */

const PROMPT = /›|auto >/;

describe("paying from the prompt", () => {
  let model: AnthropicStub;
  let billing: BillingStub;
  let cwd: string;
  let configDir: string;
  let proc: NovaProcess | undefined;

  beforeEach(async () => {
    model = await startAnthropicStub();
    billing = await startBillingStub(1_240);
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-pty-pay-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-pty-pay-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await model.close();
    await billing.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(env: Record<string, string> = {}): NovaProcess {
    proc = spawnNova({
      cwd,
      cols: 110,
      args: ["--currency", "USD"],
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: model.url,
        NOVA_CONFIG_DIR: configDir,
        NOVA_FX_OFFLINE: "true",
        NOVA_BILLING_URL: billing.url,
        NOVA_BILLING_KEY: "sk-billing-test",
        TZ: "UTC",
        ...env,
      },
    });
    return proc;
  }

  it("shows the balance without being asked for money", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const since = p.output().length;
    p.writeLine("/pay");
    await p.waitFor(/Balance 1,240 RWF/, { since, timeoutMs: 30_000 });
    expect(billing.creations()).toHaveLength(0);
  });

  it("creates nothing until the person confirms, then creates exactly one payment", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });

    let since = p.output().length;
    p.writeLine("/pay 5000");
    await p.waitFor(/Create this payment\?/, { since, timeoutMs: 30_000 });
    // The quote is on screen and the question is unanswered: nothing may exist yet.
    expect(p.output().slice(since)).toContain("5,000 RWF");
    expect(billing.creations()).toHaveLength(0);

    since = p.output().length;
    p.writeLine("y");
    await p.waitFor(/8Q2F-7KDA/, { since, timeoutMs: 30_000 });
    expect(billing.creations()).toHaveLength(1);
    expect(billing.creations()[0]).toMatchObject({ amount: 5_000 });
    expect(billing.creations()[0].idempotencyKey).toMatch(/^nova-topup-/);

    since = p.output().length;
    billing.markPaid();
    await p.waitFor(/Paid 5,000 RWF/, { since, timeoutMs: 30_000 });
    // The balance shown after the payment is the one the service reports, not 1,240 + 5,000 done here.
    await p.waitFor(/Balance now 6,240 RWF/, { since, timeoutMs: 30_000 });
  });

  it("charges nothing when the person declines", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const since = p.output().length;
    p.writeLine("/pay 5000");
    await p.waitFor(/Create this payment\?/, { since, timeoutMs: 30_000 });
    p.writeLine("n");
    await p.waitFor(/nothing was charged/i, { since, timeoutMs: 30_000 });
    expect(billing.creations()).toHaveLength(0);
  });

  it("says which settings are missing instead of half-working", async () => {
    const p = boot({ NOVA_BILLING_URL: "", NOVA_BILLING_KEY: "" });
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    const since = p.output().length;
    p.writeLine("/pay 5000");
    await p.waitFor(/NOVA_BILLING_URL/, { since, timeoutMs: 30_000 });
    expect(p.output().slice(since)).toContain("NOVA_BILLING_KEY");
    expect(billing.creations()).toHaveLength(0);
  });

  it("sets and persists a local balance without calling the balance endpoint", async () => {
    const p = boot({
      NOVA_BILLING_URL: "",
      NOVA_BILLING_KEY: "",
      NOVA_FX_RWF_PER_USD: "1300",
    });
    await p.waitFor(PROMPT, { timeoutMs: 60_000 });
    let since = p.output().length;
    p.writeLine("/balance 5000");
    await p.waitFor(/Local balance set to 5,000 RWF/, { since, timeoutMs: 30_000 });
    expect(JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"))).toMatchObject({
      NOVA_ACCOUNT_BALANCE_RWF: "5000",
    });

    since = p.output().length;
    p.writeLine("/pay");
    await p.waitFor(/Locally estimated balance: 5,000 RWF/, { since, timeoutMs: 30_000 });
    expect(p.output().slice(since)).toContain("bypasses the balance endpoint");
  });
});
