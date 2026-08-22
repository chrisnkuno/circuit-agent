import { describe, expect, it } from "vitest";
import {
  BILLING_NOT_CONFIGURED,
  formatRwf,
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
    expect(renderBalance({ balanceRwf: 9_000, asOf: 0 }, { sessionSpendRwf: 1_500 }).join("\n")).not.toMatch(/less than this session/i);
  });

  it("names both settings when there is no gateway to call", () => {
    expect(BILLING_NOT_CONFIGURED.join(" ")).toContain("NOVA_BILLING_URL");
    expect(BILLING_NOT_CONFIGURED.join(" ")).toContain("NOVA_BILLING_KEY");
  });
});
