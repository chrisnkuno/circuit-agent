/**
 * Paying for Nova from the terminal.
 *
 * Three rules shape everything below, and each one is a constraint on the *code*, not advice:
 *
 * **The CLI never touches payment instruments.** It asks the gateway to create a checkout, shows
 * the user a URL and a short code, and waits. Card numbers, PINs and mobile-money confirmations
 * happen on the provider's own surface, which is the only place they belong — a terminal that
 * collects a PIN is a terminal that has to be trusted with one, and no amount of care makes that
 * the right shape.
 *
 * **Money is an integer, always.** Amounts are whole RWF, which has no minor unit, and a float
 * would eventually charge someone 4999.999999999999. Parsing rejects decimals rather than rounding
 * them, because silently rounding a number someone typed about money is how trust is lost.
 *
 * **The balance is reported, never inferred.** Nothing here computes what a balance "should" be
 * after a payment; it re-reads it from the gateway. A local sum that disagrees with the provider's
 * ledger is worse than no number at all, and it is the disagreement users notice first.
 *
 * The gateway is an interface with a Circuit Pay adapter behind it because Circuit Pay's real
 * contract is not verified yet (see docs/planning/gap-register.md). Everything above this line — the
 * command, the confirmation, the polling, the rendering — is written against the interface, so
 * verifying that contract is an adapter change and not a feature rewrite.
 */

/** A whole number of RWF. Negative and fractional amounts never reach a gateway. */
export type Rwf = number;

export type PaymentStatus = "pending" | "paid" | "failed" | "expired";

export type Checkout = {
  /** The gateway's own id for this payment. The only handle the CLI keeps. */
  reference: string;
  amountRwf: Rwf;
  /** Where the user completes the payment. Opened or printed; never fetched by the CLI. */
  url: string;
  /** Short human code for reading aloud or typing on a phone. Optional: not every gateway has one. */
  code?: string;
  /** Epoch ms after which this checkout can no longer be paid, when the gateway says. */
  expiresAt?: number;
};

export type Payment = {
  reference: string;
  status: PaymentStatus;
  amountRwf: Rwf;
  paidAt?: number;
  /** Why a failed or expired payment ended that way, in words a user can act on. */
  detail?: string;
};

export type Balance = {
  balanceRwf: Rwf;
  /** Epoch ms the gateway computed this at, so a stale figure can be shown as stale. */
  asOf: number;
};

export type CheckoutRequest = {
  amountRwf: Rwf;
  /**
   * Stable for one top-up attempt, across every retry of the create call.
   *
   * This is the whole double-charge defence: a create that times out after the gateway accepted it
   * is retried with the same key and returns the same checkout instead of a second one.
   */
  idempotencyKey: string;
};

export interface BillingGateway {
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  getPayment(reference: string): Promise<Payment>;
  getBalance(): Promise<Balance>;
}

/**
 * Where a balance stops being comfortable, and where it stops being usable.
 *
 * These live here rather than beside the CLI's balance watcher because the terminal is no longer
 * the only surface that judges a balance: the desktop window draws the same verdict as a gauge and
 * a sentence. Two copies of "low means 2,000" would drift, and the first anyone would know of it is
 * a window calling a balance healthy while the terminal calls it low — on the same account, in the
 * same minute. One number, read by both.
 */
export const CRITICAL_BALANCE_RWF = 500;
export const LOW_BALANCE_RWF = 2_000;

/** Bounds on a single top-up. Below the floor is not worth a checkout; above the ceiling is a typo. */
export const MINIMUM_TOP_UP_RWF = 500;
export const MAXIMUM_TOP_UP_RWF = 5_000_000;

export class BillingError extends Error {
  constructor(message: string, readonly kind: "amount" | "config" | "network" | "gateway" = "gateway") {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * Reads an amount a person typed into whole RWF.
 *
 * Accepts the separators people actually use (`5,000`, `5 000`, `5_000`) and a trailing currency
 * word, and refuses everything else *by saying what it refused*. Deliberately no `k` suffix and no
 * decimals: "5k" is an abbreviation whose expansion the user cannot see before confirming, and a
 * decimal in a currency with no minor unit is a mistake, not a smaller amount.
 */
export function parseAmountRwf(text: string): Rwf {
  const raw = text.trim().replace(/\s*(rwf|frw)$/i, "").trim();
  if (!raw) throw new BillingError("Say how much to top up, e.g. /pay 5000.", "amount");
  // A comma is a thousands separator only when it groups three digits. `5,000` is five thousand;
  // `5,50` is half of something in a locale that writes decimals that way, and guessing which one
  // a user meant is precisely the guess not to make about money.
  const decimal = /\.\d/.test(raw) || (raw.includes(",") && !/^\d{1,3}(,\d{3})+$/.test(raw));
  if (decimal) throw new BillingError("RWF has no decimals — use a whole amount like 5000.", "amount");
  const cleaned = raw.replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) throw new BillingError(`'${text.trim()}' is not an amount. Use a whole number of RWF, e.g. 5000.`, "amount");
  return assertTopUpAmount(Number(cleaned));
}

/** The one place an amount is judged fit to charge. Every path to a gateway goes through it. */
export function assertTopUpAmount(amount: number): Rwf {
  if (!Number.isInteger(amount)) throw new BillingError("RWF has no decimals — use a whole amount like 5000.", "amount");
  if (amount < MINIMUM_TOP_UP_RWF) throw new BillingError(`The smallest top-up is ${MINIMUM_TOP_UP_RWF} RWF.`, "amount");
  if (amount > MAXIMUM_TOP_UP_RWF) throw new BillingError(`${amount} RWF is above the ${MAXIMUM_TOP_UP_RWF} RWF single-payment limit. Pay in smaller amounts, or contact support.`, "amount");
  return amount;
}

/** A key unique to this attempt. Random rather than derived from the amount: two deliberate 5,000 RWF top-ups are two payments. */
export function newIdempotencyKey(random: () => string = () => Math.random().toString(36).slice(2)): string {
  return `nova-topup-${Date.now().toString(36)}-${random()}${random()}`.slice(0, 64);
}

const TERMINAL: readonly PaymentStatus[] = ["paid", "failed", "expired"];

export function isPaymentSettled(status: PaymentStatus): boolean {
  return TERMINAL.includes(status);
}

export type WaitOptions = {
  /** Stops polling after this long. The payment is *not* cancelled — see the return value. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Called before each wait, so a caller can animate without knowing how polling works. */
  onPoll?: (payment: Payment, attempt: number) => void;
  signal?: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WaitResult = {
  payment: Payment;
  /**
   * True when polling gave up while the payment was still pending.
   *
   * The distinction matters more than anything else here: a timeout is not a failure, and telling
   * someone their payment failed when it is merely unconfirmed invites them to pay twice. The
   * caller must report "not confirmed yet" and hand back the reference.
   */
  timedOut: boolean;
};

/**
 * Polls until the payment reaches a terminal state, the caller cancels, or time runs out.
 *
 * A transient read error does not end the wait — the payment is in flight on someone's phone and a
 * dropped poll says nothing about it — but a run of consecutive failures does, because at that
 * point the CLI is reporting confidence it does not have.
 */
export async function waitForPayment(gateway: BillingGateway, reference: string, options: WaitOptions = {}): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;

  let last: Payment = { reference, status: "pending", amountRwf: 0 };
  let consecutiveErrors = 0;
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) return { payment: last, timedOut: true };
    try {
      last = await gateway.getPayment(reference);
      consecutiveErrors = 0;
      if (isPaymentSettled(last.status)) return { payment: last, timedOut: false };
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) throw error;
    }
    options.onPoll?.(last, attempt);
    if (now() >= deadline) return { payment: last, timedOut: true };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

export type CircuitPayOptions = {
  baseUrl: string;
  apiKey: string;
  /** Injected for tests, and so the CLI can apply its own timeout and proxy rules. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** Reads the gateway's own configuration out of the environment, or explains exactly what is missing. */
export function billingFromEnvironment(
  environment: Record<string, string | undefined>,
  fetchImpl?: typeof globalThis.fetch,
  options: { timeoutMs?: number } = {},
): BillingGateway | null {
  const baseUrl = environment.NOVA_BILLING_URL?.trim();
  const apiKey = environment.NOVA_BILLING_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return new CircuitPayGateway({ baseUrl, apiKey, fetch: fetchImpl, ...options });
}

/**
 * Circuit Pay over HTTP.
 *
 * Every response is validated before it is believed. A gateway that answers with a 200 and a body
 * missing `status` is not "probably fine": this is the code path that decides whether someone's
 * money arrived, and a missing field there must raise rather than default to something cheerful.
 */
export class CircuitPayGateway implements BillingGateway {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CircuitPayOptions) {
    if (!options.baseUrl?.trim()) throw new BillingError("No billing URL configured. Set NOVA_BILLING_URL.", "config");
    if (!options.apiKey?.trim()) throw new BillingError("No billing key configured. Set NOVA_BILLING_KEY.", "config");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    assertTopUpAmount(request.amountRwf);
    if (!request.idempotencyKey.trim()) throw new BillingError("A top-up needs an idempotency key.", "gateway");
    const body = await this.call("POST", "/v1/checkouts", {
      // Currency travels explicitly even though it is always RWF today: a gateway that starts
      // accepting a second currency must not read an amount as the wrong one.
      body: { amount: request.amountRwf, currency: "RWF", purpose: "nova_credit_topup" },
      idempotencyKey: request.idempotencyKey,
    });
    const reference = stringField(body, "reference");
    const url = stringField(body, "url");
    if (!/^https:\/\//i.test(url)) throw new BillingError("The gateway returned a checkout link that is not HTTPS; refusing to open it.", "gateway");
    return {
      reference,
      url,
      amountRwf: integerField(body, "amount", request.amountRwf),
      code: optionalString(body, "code"),
      expiresAt: optionalTimestamp(body, "expires_at"),
    };
  }

  async getPayment(reference: string): Promise<Payment> {
    const body = await this.call("GET", `/v1/checkouts/${encodeURIComponent(reference)}`);
    return {
      reference,
      status: readStatus(stringField(body, "status")),
      amountRwf: integerField(body, "amount", 0),
      paidAt: optionalTimestamp(body, "paid_at"),
      detail: optionalString(body, "detail"),
    };
  }

  async getBalance(): Promise<Balance> {
    const body = await this.call("GET", "/v1/balance");
    return { balanceRwf: integerField(body, "balance", 0), asOf: optionalTimestamp(body, "as_of") ?? Date.now() };
  }

  private async call(method: "GET" | "POST", path: string, options: { body?: unknown; idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    const url = new URL(path.replace(/^\//, ""), this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // The key is in the headers of the request that just failed; the message must name the host
      // and nothing else. An error string is the most-copied text in any CLI.
      throw new BillingError(`Could not reach the billing service at ${url.host}: ${error instanceof Error ? error.message : String(error)}`, "network");
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) throw new BillingError(gatewayMessage(response.status, text), response.status >= 500 ? "network" : "gateway");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new BillingError(`The billing service at ${url.host} returned a response that is not JSON.`, "gateway");
    }
    if (!parsed || typeof parsed !== "object") throw new BillingError("The billing service returned an unexpected response.", "gateway");
    return parsed as Record<string, unknown>;
  }
}

/** A gateway error a user can act on, without the raw body — which may carry request echoes. */
function gatewayMessage(status: number, body: string): string {
  const detail = readDetail(body);
  if (status === 401 || status === 403) return `The billing service rejected this key${detail ? ` (${detail})` : ""}. Check NOVA_BILLING_KEY.`;
  if (status === 404) return "That payment reference is not known to the billing service.";
  if (status === 429) return "The billing service is rate-limiting this key. Wait a moment and try again.";
  if (status >= 500) return `The billing service is unavailable right now (HTTP ${status}). Nothing was charged.`;
  return `The billing service refused this request (HTTP ${status})${detail ? `: ${detail}` : ""}.`;
}

function readDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : undefined;
    return message?.slice(0, 200);
  } catch {
    return undefined;
  }
}

/** An unknown status is never optimistically read as `paid`; it is a gateway the CLI does not understand. */
function readStatus(value: string): PaymentStatus {
  switch (value.toLowerCase()) {
    case "paid":
    case "succeeded":
    case "completed":
      return "paid";
    case "pending":
    case "processing":
    case "requires_action":
      return "pending";
    case "failed":
    case "cancelled":
    case "canceled":
      return "failed";
    case "expired":
      return "expired";
    default:
      throw new BillingError(`The billing service reported a payment status Nova does not understand: ${value}`, "gateway");
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new BillingError(`The billing service response is missing '${field}'.`, "gateway");
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function integerField(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new BillingError(`The billing service reported '${field}' as something other than a whole number of RWF.`, "gateway");
  return value;
}

function optionalTimestamp(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
