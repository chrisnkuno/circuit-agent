import {
  BillingError,
  MINIMUM_TOP_UP_RWF,
  parseAmountRwf,
  type Balance,
  type Checkout,
  type Payment,
} from "@circuit-nova/nova-core/nova-cli/billing";

/**
 * `/pay` — the command grammar and everything it prints.
 *
 * Split from the flow in nova.ts on purpose. This file is where the wording of a money screen
 * lives, and money wording is exactly the kind of thing that should be asserted in tests rather
 * than eyeballed once: "paid" must never appear for an unconfirmed payment, the reference must
 * survive every unhappy ending, and an amount must be shown the same way in the confirmation and
 * in the receipt, because a user comparing the two is checking whether they were charged what they
 * agreed to.
 *
 * Nothing here talks to a gateway or reads a key. It parses, and it renders.
 */

export type PayCommand =
  | { kind: "topup"; amountRwf: number }
  /** `/pay` with no argument: show where the balance stands and how to add to it. */
  | { kind: "balance" }
  /** `/pay status <reference>`: check a payment that was left unconfirmed. */
  | { kind: "status"; reference: string }
  | { kind: "invalid"; reason: string };

/** Not a `/pay` command at all — `/payments`, say — so the dispatcher keeps looking. */
export function parsePayCommand(input: string): PayCommand | null {
  const match = /^\/pay(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument || /^balance$/i.test(argument)) return { kind: "balance" };

  const status = /^status(?:\s+(\S+))?$/i.exec(argument);
  if (status) {
    return status[1]
      ? { kind: "status", reference: status[1] }
      : { kind: "invalid", reason: "Say which payment: /pay status <reference>. The reference was printed when the payment was created." };
  }

  try {
    return { kind: "topup", amountRwf: parseAmountRwf(argument) };
  } catch (error) {
    return { kind: "invalid", reason: error instanceof BillingError ? error.message : `'${argument}' is not an amount. Use /pay 5000, or /pay balance.` };
  }
}

/** RWF, grouped, with the currency named. One formatter, so the quote and the receipt cannot disagree. */
export function formatRwf(amount: number): string {
  return `${Math.trunc(amount).toLocaleString("en-US")} RWF`;
}

/**
 * What the user agrees to before anything is created.
 *
 * Shows the resulting balance when one is known, because "5,000 RWF" and "5,000 RWF, taking you to
 * 6,240" are different decisions — the second one is the one people actually want to make.
 */
export function renderTopUpQuote(amountRwf: number, balance?: Balance): string[] {
  const lines = [`Top up ${formatRwf(amountRwf)}`];
  if (balance) lines.push(`Balance ${formatRwf(balance.balanceRwf)} → ${formatRwf(balance.balanceRwf + amountRwf)} once it clears`);
  lines.push("You will pay on Circuit Pay's own page — Nova never sees your card or PIN.");
  return lines;
}

/** The checkout itself: where to pay, and what to quote if the page asks for a code. */
export function renderCheckout(checkout: Checkout, now = Date.now()): string[] {
  const lines = [`Pay ${formatRwf(checkout.amountRwf)} at ${checkout.url}`];
  if (checkout.code) lines.push(`Code ${checkout.code}`);
  if (checkout.expiresAt && checkout.expiresAt > now) {
    lines.push(`Expires in ${Math.max(1, Math.round((checkout.expiresAt - now) / 60_000))} min`);
  }
  lines.push(`Reference ${checkout.reference} — keep this; /pay status ${checkout.reference} checks it later.`);
  return lines;
}

/**
 * How a top-up ended.
 *
 * The unconfirmed case is the one this file exists for. A payment that has not been confirmed is
 * *not* a failed payment: the money may well be moving, and a CLI that says "failed" is a CLI that
 * gets paid twice. It says so plainly, keeps the reference in front of the user, and never prints
 * a new balance it did not read back from the gateway.
 */
export function renderPaymentOutcome(payment: Payment, options: { timedOut: boolean; balance?: Balance } = { timedOut: false }): string[] {
  if (options.timedOut || payment.status === "pending") {
    return [
      `Not confirmed yet — ${formatRwf(payment.amountRwf)} is still pending.`,
      "Do not pay again: if you completed it, it will clear on its own.",
      `Check it with /pay status ${payment.reference}.`,
    ];
  }
  if (payment.status === "paid") {
    const lines = [`Paid ${formatRwf(payment.amountRwf)} — reference ${payment.reference}.`];
    if (options.balance) lines.push(`Balance now ${formatRwf(options.balance.balanceRwf)}.`);
    return lines;
  }
  if (payment.status === "expired") {
    return [`That checkout expired before it was paid — nothing was charged.`, `Run /pay ${payment.amountRwf || MINIMUM_TOP_UP_RWF} again to get a fresh link.`];
  }
  return [
    `The payment did not go through${payment.detail ? `: ${payment.detail}` : "."}`,
    "Nothing was charged. Try again, or use a different payment method on the checkout page.",
  ];
}

/** The balance, and the one thing worth saying about it. */
export function renderBalance(balance: Balance, options: { sessionSpendRwf?: number } = {}): string[] {
  const lines = [`Balance ${formatRwf(balance.balanceRwf)}`];
  if (options.sessionSpendRwf !== undefined && options.sessionSpendRwf > 0) {
    lines.push(`This session has used ${formatRwf(options.sessionSpendRwf)}.`);
  }
  if (balance.balanceRwf <= 0) lines.push("Top up before the next turn: /pay 5000.");
  else if (options.sessionSpendRwf !== undefined && options.sessionSpendRwf > 0 && balance.balanceRwf < options.sessionSpendRwf) {
    // Compared against this session rather than a fixed floor: "less than you just spent" is a
    // threshold that means something to the person reading it, and it scales with how they work.
    lines.push("That is less than this session has already used — consider /pay before starting more work.");
  }
  return lines;
}

/** Shown when `/pay` runs with no gateway configured. Names the two settings and stops. */
export const BILLING_NOT_CONFIGURED = [
  "Paying from the CLI needs a billing endpoint.",
  "Set NOVA_BILLING_URL and NOVA_BILLING_KEY in /settings, then run /pay again.",
];
