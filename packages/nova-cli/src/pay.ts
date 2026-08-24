import {
  CRITICAL_BALANCE_RWF,
  LOW_BALANCE_RWF,
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

export type ManualBalanceCommand =
  | { kind: "show" }
  | { kind: "set"; amountRwf: number }
  | { kind: "clear" }
  | { kind: "invalid"; reason: string };

/** `/balance` controls the local estimate used when the account balance endpoint is unavailable. */
export function parseManualBalanceCommand(input: string): ManualBalanceCommand | null {
  const match = /^\/balance(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "show" };
  if (/^(?:clear|auto|gateway)$/i.test(argument)) return { kind: "clear" };
  const cleaned = argument.replace(/\s*(?:rwf|frw)$/i, "").replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) {
    return { kind: "invalid", reason: "Use a whole RWF amount, for example /balance 5000, or /balance clear." };
  }
  const amountRwf = Number(cleaned);
  if (!Number.isSafeInteger(amountRwf)) {
    return { kind: "invalid", reason: "That balance is too large to track safely." };
  }
  return { kind: "set", amountRwf };
}

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

export type BalanceAlert = {
  kind: "empty" | "critical" | "low" | "rapid";
  lines: string[];
};

/** Re-exported so existing callers keep their import; the number itself now lives in core. */
export { CRITICAL_BALANCE_RWF } from "@circuit-nova/nova-core/nova-cli/billing";

export type TaskBalanceGate = {
  blocked: boolean;
  lines: string[];
};

/**
 * Compares a token-based task forecast with confirmed credit before the model sees the request.
 * The low end may block; the high end may only warn, because a forecast range is not a bill.
 */
export function assessTaskBalance(
  balance: Balance,
  estimate: { lowRwf: number; highRwf: number },
  options: { source?: "confirmed" | "manual" } = {},
): TaskBalanceGate | undefined {
  const describedBalance = options.source === "manual"
    ? `locally estimated ${formatRwf(balance.balanceRwf)} balance`
    : `confirmed ${formatRwf(balance.balanceRwf)} balance`;
  if (estimate.lowRwf > balance.balanceRwf) {
    return {
      blocked: true,
      lines: [
        `This task cannot start with the current balance. Its conservative estimate begins at ${formatRwf(estimate.lowRwf)}, but ${formatRwf(balance.balanceRwf)} remains.`,
        "Nothing was sent to the model. Top up with /pay, use /slow, or ask for a smaller first step.",
      ],
    };
  }
  if (estimate.highRwf > balance.balanceRwf) {
    return {
      blocked: false,
      lines: [
        `This task may need up to ${formatRwf(estimate.highRwf)}, above the ${describedBalance}.`,
        "You can keep control by using /slow, splitting the task, or topping up with /pay.",
      ],
    };
  }
  return undefined;
}

export type BalanceWatchOptions = {
  /** A simple floor for a new or nearly idle session, configurable through NOVA_LOW_BALANCE_RWF. */
  lowBalanceRwf?: number;
  /** Two confirmed readings inside this window may describe a rapid decline. */
  rapidWindowMs?: number;
  /** Ignore tiny movements even when they are a large percentage of a tiny balance. */
  minimumRapidDropRwf?: number;
  /** The fraction of the previous confirmed balance that counts as a rapid decline. */
  rapidDropFraction?: number;
  /** Do not repeat the same level of warning every turn. */
  repeatAfterMs?: number;
};

type BalanceObservation = { balance: Balance; observedAt: number };

/**
 * Turns authoritative gateway balances into quiet, actionable notifications.
 *
 * The watcher never derives a balance from local spend. It compares two values read from the
 * gateway, and only uses the local session average to label an explicitly approximate runway.
 * This distinction is important: another device or process may be spending the same account.
 */
export class BalanceWatch {
  private previous: BalanceObservation | undefined;
  private lastAlert: { kind: BalanceAlert["kind"]; at: number } | undefined;
  private readonly options: Required<BalanceWatchOptions>;

  constructor(options: BalanceWatchOptions = {}) {
    this.options = {
      lowBalanceRwf: options.lowBalanceRwf ?? LOW_BALANCE_RWF,
      rapidWindowMs: options.rapidWindowMs ?? 30 * 60_000,
      minimumRapidDropRwf: options.minimumRapidDropRwf ?? 500,
      rapidDropFraction: options.rapidDropFraction ?? 0.25,
      repeatAfterMs: options.repeatAfterMs ?? 30 * 60_000,
    };
  }

  observe(
    balance: Balance,
    context: { sessionSpendRwf?: number; sessionTurns?: number; now?: number; silent?: boolean } = {},
  ): BalanceAlert | undefined {
    const now = context.now ?? Date.now();
    const prior = this.previous;
    // A delayed cache or replica must not make an older balance look like a new movement.
    if (prior && balance.asOf < prior.balance.asOf) return undefined;
    this.previous = { balance, observedAt: now };
    if (context.silent) return undefined;

    const averageTurn = context.sessionSpendRwf && context.sessionTurns
      ? context.sessionSpendRwf / context.sessionTurns
      : undefined;
    const turnsLeft = averageTurn && averageTurn > 0 ? Math.floor(balance.balanceRwf / averageTurn) : undefined;
    const isLow = balance.balanceRwf <= this.options.lowBalanceRwf || (turnsLeft !== undefined && turnsLeft <= 2);
    const drop = prior ? prior.balance.balanceRwf - balance.balanceRwf : 0;
    const elapsed = prior ? Math.max(0, now - prior.observedAt) : Number.POSITIVE_INFINITY;
    const rapid = Boolean(
      prior
      && elapsed <= this.options.rapidWindowMs
      && drop >= this.options.minimumRapidDropRwf
      && drop / Math.max(1, prior.balance.balanceRwf) >= this.options.rapidDropFraction,
    );

    const kind: BalanceAlert["kind"] | undefined = balance.balanceRwf <= 0
      ? "empty"
      : balance.balanceRwf < CRITICAL_BALANCE_RWF
        ? "critical"
        : rapid
          ? "rapid"
          : isLow
            ? "low"
            : undefined;
    if (!kind) {
      this.lastAlert = undefined;
      return undefined;
    }
    if (this.lastAlert?.kind === kind && now - this.lastAlert.at < this.options.repeatAfterMs) return undefined;
    this.lastAlert = { kind, at: now };

    if (kind === "empty") {
      return {
        kind,
        lines: [
          "Balance watch: no Nova credit remains.",
          "Nova will not top up automatically. Add credit when you choose with /pay 5000.",
        ],
      };
    }
    if (kind === "critical") {
      return {
        kind,
        lines: [
          `Balance watch: only ${formatRwf(balance.balanceRwf)} remains — below the ${formatRwf(CRITICAL_BALANCE_RWF)} critical level.`,
          "Nova will check a task's estimate before sending it. Nothing will top up automatically; use /pay when you choose.",
        ],
      };
    }

    const runway = turnsLeft !== undefined
      ? ` At this session's average, that is about ${turnsLeft} more turn${turnsLeft === 1 ? "" : "s"}.`
      : "";
    if (kind === "rapid") {
      const minutes = Math.max(1, Math.round(elapsed / 60_000));
      const percent = prior ? Math.round((drop / Math.max(1, prior.balance.balanceRwf)) * 100) : 0;
      return {
        kind,
        lines: [
          `Balance watch: down ${formatRwf(drop)} (${percent}%) in about ${minutes} min; ${formatRwf(balance.balanceRwf)} remains.${runway}`,
          "You are still in control: Nova will not top up automatically. Use /cost to review it, /slow to reduce the pace, or /pay when you choose.",
        ],
      };
    }
    return {
      kind,
      lines: [
        `Balance watch: getting low — ${formatRwf(balance.balanceRwf)} remains.${runway}`,
        "Nova will not top up automatically. Use /cost to review spending, /slow to reduce the pace, or /pay when you choose.",
      ],
    };
  }
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
  else if (balance.balanceRwf < CRITICAL_BALANCE_RWF) lines.push(`Critical balance: below ${formatRwf(CRITICAL_BALANCE_RWF)}. A demanding task may not be able to start; /pay 5000 tops up when you choose.`);
  if (balance.balanceRwf > 0 && options.sessionSpendRwf !== undefined && options.sessionSpendRwf > 0 && balance.balanceRwf < options.sessionSpendRwf) {
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
