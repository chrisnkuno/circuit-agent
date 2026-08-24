import { describe, expect, it } from "vitest";
import {
  BILLING_NOT_CONFIGURED,
  BalanceWatch,
  assessTaskBalance,
  formatRwf,
  parseManualBalanceCommand,
  parsePayCommand,
  renderBalance,
  renderCheckout,
  renderPaymentOutcome,
  renderTopUpQuote,
} from "./pay";

describe("/pay grammar", () => {
  it("reads an amount, in the shapes people type it", () => {
    expect(parsePayCommand("/pay 5000")).toEqual({ kind: "topup", amountRwf: 5_000 });
    expect(parsePayCommand("  /pay 5,000 RWF  ")).toEqual({ kind: "topup", amountRwf: 5_000 });
  });

  it("treats a bare /pay as a balance check rather than an amount-less charge", () => {
    expect(parsePayCommand("/pay")).toEqual({ kind: "balance" });
    expect(parsePayCommand("/pay balance")).toEqual({ kind: "balance" });
  });

  it("checks one payment by reference, and says how when the reference is missing", () => {
    expect(parsePayCommand("/pay status CP-91f2")).toEqual({ kind: "status", reference: "CP-91f2" });
    expect(parsePayCommand("/pay status")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("/pay status <reference>") });
  });

  it("explains a bad amount instead of charging a guess", () => {
    expect(parsePayCommand("/pay 5000.75")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/decimals/i) });
    expect(parsePayCommand("/pay 100")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/smallest top-up/i) });
    expect(parsePayCommand("/pay lots")).toMatchObject({ kind: "invalid" });
  });

  it("is not a /pay command", () => {
    expect(parsePayCommand("/payments")).toBeNull();
    expect(parsePayCommand("pay 5000")).toBeNull();
  });
});

describe("/balance grammar", () => {
  it("sets, shows and clears a user-supplied local balance", () => {
    expect(parseManualBalanceCommand("/balance")).toEqual({ kind: "show" });
    expect(parseManualBalanceCommand("/balance 12,500 RWF")).toEqual({ kind: "set", amountRwf: 12_500 });
    expect(parseManualBalanceCommand("/balance clear")).toEqual({ kind: "clear" });
    expect(parseManualBalanceCommand("/balances 5000")).toBeNull();
  });

  it("rejects ambiguous or unsafe amounts", () => {
    expect(parseManualBalanceCommand("/balance 20.5")?.kind).toBe("invalid");
    expect(parseManualBalanceCommand("/balance -1")?.kind).toBe("invalid");
    expect(parseManualBalanceCommand(`/balance ${"9".repeat(40)}`)?.kind).toBe("invalid");
  });
});

describe("proactive balance watch", () => {
  it("warns about a low confirmed balance with calm, actionable controls", () => {
    const watch = new BalanceWatch();
    const alert = watch.observe(
      { balanceRwf: 1_200, asOf: 1 },
      { sessionSpendRwf: 1_500, sessionTurns: 3, now: 1 },
    );

    expect(alert?.kind).toBe("low");
    expect(alert?.lines.join(" ")).toContain("1,200 RWF");
    expect(alert?.lines.join(" ")).toMatch(/about 2 more turns/i);
    expect(alert?.lines.join(" ")).toMatch(/will not top up automatically/i);
    expect(alert?.lines.join(" ")).toContain("/slow");
  });

  it("calls out a fast decrease using two gateway-confirmed readings", () => {
    const watch = new BalanceWatch();
    watch.observe({ balanceRwf: 8_000, asOf: 1 }, { now: 1, silent: true });
    const alert = watch.observe({ balanceRwf: 5_500, asOf: 2 }, { now: 5 * 60_000 });

    expect(alert?.kind).toBe("rapid");
    expect(alert?.lines.join(" ")).toMatch(/down 2,500 RWF \(31%\)/i);
    expect(alert?.lines.join(" ")).toMatch(/about 5 min/i);
    expect(alert?.lines.join(" ")).toContain("/cost");
  });

  it("does not manufacture urgency from small changes or repeat every turn", () => {
    const watch = new BalanceWatch({ lowBalanceRwf: 2_000 });
    expect(watch.observe({ balanceRwf: 8_000, asOf: 1 }, { now: 1 })).toBeUndefined();
    expect(watch.observe({ balanceRwf: 7_800, asOf: 2 }, { now: 60_000 })).toBeUndefined();

    expect(watch.observe({ balanceRwf: 1_900, asOf: 3 }, { now: 32 * 60_000 })?.kind).toBe("low");
    expect(watch.observe({ balanceRwf: 1_800, asOf: 4 }, { now: 33 * 60_000 })).toBeUndefined();
  });

  it("treats an empty balance as a stronger state and resets after a top-up", () => {
    const watch = new BalanceWatch();
    expect(watch.observe({ balanceRwf: 0, asOf: 1 }, { now: 1 })?.kind).toBe("empty");
    expect(watch.observe({ balanceRwf: 10_000, asOf: 2 }, { now: 2 })).toBeUndefined();
    expect(watch.observe({ balanceRwf: 1_500, asOf: 3 }, { now: 40 * 60_000 })?.kind).toBe("low");
  });

  it("uses a distinct critical warning below 500 RWF", () => {
    const watch = new BalanceWatch();
    const alert = watch.observe({ balanceRwf: 499, asOf: 1 }, { now: 1 });
    expect(alert?.kind).toBe("critical");
    expect(alert?.lines.join(" ")).toMatch(/below the 500 RWF critical level/i);
    expect(alert?.lines.join(" ")).toMatch(/check a task's estimate before sending/i);
  });

  it("blocks only when even the conservative task estimate exceeds the balance", () => {
    const blocked = assessTaskBalance({ balanceRwf: 400, asOf: 1 }, { lowRwf: 650, highRwf: 1_200 });
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.lines.join(" ")).toMatch(/nothing was sent to the model/i);

    const warning = assessTaskBalance({ balanceRwf: 900, asOf: 1 }, { lowRwf: 300, highRwf: 1_200 });
    expect(warning?.blocked).toBe(false);
    expect(assessTaskBalance({ balanceRwf: 2_000, asOf: 1 }, { lowRwf: 300, highRwf: 1_200 })).toBeUndefined();
  });

  it("ignores an older gateway snapshot", () => {
    const watch = new BalanceWatch();
    watch.observe({ balanceRwf: 10_000, asOf: 20 }, { now: 1, silent: true });
    expect(watch.observe({ balanceRwf: 1_000, asOf: 10 }, { now: 2 })).toBeUndefined();
  });
});

describe("what a money screen says", () => {
  it("shows the same amount in the quote and in the receipt", () => {
    const quote = renderTopUpQuote(5_000, { balanceRwf: 1_240, asOf: 0 }).join("\n");
    const receipt = renderPaymentOutcome({ reference: "CP-1", status: "paid", amountRwf: 5_000 }, { timedOut: false, balance: { balanceRwf: 6_240, asOf: 0 } }).join("\n");
    expect(quote).toContain(formatRwf(5_000));
    expect(receipt).toContain(formatRwf(5_000));
    expect(quote).toContain("1,240 RWF → 6,240 RWF");
    expect(receipt).toContain("Balance now 6,240 RWF");
  });

  it("says Nova never sees the payment instrument, before anything is created", () => {
    expect(renderTopUpQuote(5_000).join(" ")).toMatch(/never sees your card or PIN/i);
  });

  it("never calls an unconfirmed payment paid or failed, and keeps the reference in front of the user", () => {
    for (const outcome of [
      renderPaymentOutcome({ reference: "CP-1", status: "pending", amountRwf: 5_000 }, { timedOut: true }),
      renderPaymentOutcome({ reference: "CP-1", status: "pending", amountRwf: 5_000 }, { timedOut: false }),
    ]) {
      const text = outcome.join("\n");
      expect(text).toMatch(/not confirmed yet/i);
      expect(text).toMatch(/do not pay again/i);
      expect(text).toContain("/pay status CP-1");
      expect(text.toLowerCase()).not.toContain("failed");
      expect(text).not.toMatch(/\bpaid\b(?! again)/i);
    }
  });

  it("says plainly that nothing was charged when a payment failed or expired", () => {
    expect(renderPaymentOutcome({ reference: "CP-1", status: "failed", amountRwf: 5_000, detail: "insufficient funds" }).join("\n"))
      .toMatch(/nothing was charged/i);
    expect(renderPaymentOutcome({ reference: "CP-1", status: "failed", amountRwf: 5_000, detail: "insufficient funds" }).join("\n"))
      .toContain("insufficient funds");
    expect(renderPaymentOutcome({ reference: "CP-1", status: "expired", amountRwf: 5_000 }).join("\n")).toMatch(/nothing was charged/i);
  });

  it("prints a balance it was given and never one it worked out itself", () => {
    // A paid payment with no balance read back says nothing about the balance at all.
    const withoutBalance = renderPaymentOutcome({ reference: "CP-1", status: "paid", amountRwf: 5_000 }, { timedOut: false }).join("\n");
    expect(withoutBalance).toContain("Paid 5,000 RWF");
    expect(withoutBalance).not.toMatch(/balance/i);
  });

  it("hands over the reference and the code with the link", () => {
    const lines = renderCheckout({ reference: "CP-1", amountRwf: 5_000, url: "https://pay.example/c/8Q2F", code: "8Q2F", expiresAt: 600_000 }, 0).join("\n");
    expect(lines).toContain("https://pay.example/c/8Q2F");
    expect(lines).toContain("Code 8Q2F");
    expect(lines).toContain("Expires in 10 min");
    expect(lines).toContain("Reference CP-1");
  });

  it("warns when the balance will not cover another session like this one", () => {
    expect(renderBalance({ balanceRwf: 200, asOf: 0 }, { sessionSpendRwf: 1_500 }).join("\n")).toMatch(/less than this session/i);
    expect(renderBalance({ balanceRwf: 0, asOf: 0 }).join("\n")).toMatch(/top up/i);
    expect(renderBalance({ balanceRwf: 499, asOf: 0 }).join("\n")).toMatch(/critical balance/i);
    expect(renderBalance({ balanceRwf: 9_000, asOf: 0 }, { sessionSpendRwf: 1_500 }).join("\n")).not.toMatch(/less than this session/i);
  });

  it("names both settings when there is no gateway to call", () => {
    expect(BILLING_NOT_CONFIGURED.join(" ")).toContain("NOVA_BILLING_URL");
    expect(BILLING_NOT_CONFIGURED.join(" ")).toContain("NOVA_BILLING_KEY");
  });
});
