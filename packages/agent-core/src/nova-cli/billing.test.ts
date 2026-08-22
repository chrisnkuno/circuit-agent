import { describe, expect, it, vi } from "vitest";
import {
  BillingError,
  CircuitPayGateway,
  MAXIMUM_TOP_UP_RWF,
  MINIMUM_TOP_UP_RWF,
  assertTopUpAmount,
  billingFromEnvironment,
  isPaymentSettled,
  newIdempotencyKey,
  parseAmountRwf,
  waitForPayment,
  type BillingGateway,
  type Payment,
} from "./billing";

/** A gateway whose answers a test dictates, recording exactly what it was asked. */
function scriptedGateway(payments: Payment[]): BillingGateway & { calls: number } {
  const gateway = {
    calls: 0,
    async createCheckout() { throw new Error("not used"); },
    async getPayment(reference: string): Promise<Payment> {
      const next = payments[Math.min(gateway.calls, payments.length - 1)];
      gateway.calls += 1;
      return { ...next, reference };
    },
    async getBalance() { return { balanceRwf: 0, asOf: 0 }; },
  };
  return gateway;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("what counts as an amount", () => {
  it("accepts the separators people type and nothing else", () => {
    expect(parseAmountRwf("5000")).toBe(5_000);
    expect(parseAmountRwf(" 5,000 ")).toBe(5_000);
    expect(parseAmountRwf("5 000 RWF")).toBe(5_000);
    expect(parseAmountRwf("5_000")).toBe(5_000);
  });

  it("refuses decimals rather than rounding money someone typed", () => {
    // RWF has no minor unit; silently turning 5000.75 into 5001 charges a number nobody agreed to.
    expect(() => parseAmountRwf("5000.75")).toThrow(/no decimals/i);
    expect(() => parseAmountRwf("5,000.5")).toThrow(/no decimals/i);
  });

  it("refuses everything that is not a whole number", () => {
    for (const input of ["", "  ", "abc", "5k", "-500", "1e5", "5000$", "٥٠٠٠"]) {
      expect(() => parseAmountRwf(input), input).toThrow(BillingError);
    }
  });

  it("holds the floor and the ceiling, at the boundary", () => {
    expect(assertTopUpAmount(MINIMUM_TOP_UP_RWF)).toBe(MINIMUM_TOP_UP_RWF);
    expect(assertTopUpAmount(MAXIMUM_TOP_UP_RWF)).toBe(MAXIMUM_TOP_UP_RWF);
    expect(() => assertTopUpAmount(MINIMUM_TOP_UP_RWF - 1)).toThrow(/smallest top-up/i);
    expect(() => assertTopUpAmount(MAXIMUM_TOP_UP_RWF + 1)).toThrow(/limit/i);
    expect(() => assertTopUpAmount(0)).toThrow(BillingError);
    expect(() => assertTopUpAmount(Number.NaN)).toThrow(BillingError);
    expect(() => assertTopUpAmount(Number.POSITIVE_INFINITY)).toThrow(BillingError);
  });

  it("gives every attempt its own idempotency key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    expect([...keys].every((key) => key.length <= 64 && key.startsWith("nova-topup-"))).toBe(true);
  });
});

describe("waiting for a payment", () => {
  const sleep = async () => {};

  it("stops at the first terminal state and reports it", async () => {
    for (const status of ["paid", "failed", "expired"] as const) {
      const gateway = scriptedGateway([{ reference: "r", status: "pending", amountRwf: 5_000 }, { reference: "r", status, amountRwf: 5_000 }]);
      const result = await waitForPayment(gateway, "r", { sleep, intervalMs: 0 });
      expect(result.payment.status).toBe(status);
      expect(result.timedOut).toBe(false);
      expect(gateway.calls).toBe(2);
    }
  });

  it("never reports a pending payment as anything but pending when time runs out", async () => {
    const gateway = scriptedGateway([{ reference: "r", status: "pending", amountRwf: 5_000 }]);
    let clock = 0;
    const result = await waitForPayment(gateway, "r", { sleep, intervalMs: 10, timeoutMs: 50, now: () => (clock += 20) });
    // A timeout is not a failure: the money may still be moving, and "failed" invites a second payment.
    expect(result.timedOut).toBe(true);
    expect(result.payment.status).toBe("pending");
  });

  it("rides out a transient read failure but gives up on a run of them", async () => {
    let attempt = 0;
    const flaky: BillingGateway = {
      async createCheckout() { throw new Error("not used"); },
      async getPayment(reference) {
        attempt += 1;
        if (attempt <= 2) throw new Error("network hiccup");
        return { reference, status: "paid", amountRwf: 5_000 };
      },
      async getBalance() { return { balanceRwf: 0, asOf: 0 }; },
    };
    await expect(waitForPayment(flaky, "r", { sleep, intervalMs: 0 })).resolves.toMatchObject({ payment: { status: "paid" } });

    const broken: BillingGateway = { ...flaky, async getPayment() { throw new Error("gateway down"); } };
    await expect(waitForPayment(broken, "r", { sleep, intervalMs: 0 })).rejects.toThrow("gateway down");
  });

  it("stops when the caller cancels, without claiming an outcome", async () => {
    const gateway = scriptedGateway([{ reference: "r", status: "pending", amountRwf: 5_000 }]);
    const result = await waitForPayment(gateway, "r", { sleep, intervalMs: 0, signal: { aborted: true } });
    expect(result).toEqual({ payment: { reference: "r", status: "pending", amountRwf: 0 }, timedOut: true });
    expect(gateway.calls).toBe(0);
  });

  it("agrees with itself about which states are settled", () => {
    expect((["paid", "failed", "expired"] as const).every(isPaymentSettled)).toBe(true);
    expect(isPaymentSettled("pending")).toBe(false);
  });
});

describe("the Circuit Pay adapter", () => {
  const options = { baseUrl: "https://pay.example/api", apiKey: "sk-billing-secret" };

  it("sends the amount, the currency and the idempotency key, and never the key in a URL", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("https://pay.example/api/v1/checkouts");
      expect(String(url)).not.toContain(options.apiKey);
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-billing-secret");
      expect(JSON.parse(String(init?.body))).toMatchObject({ amount: 5_000, currency: "RWF" });
      return jsonResponse({ reference: "CP-1", url: "https://pay.example/c/8Q2F", code: "8Q2F", amount: 5_000 });
    });
    const gateway = new CircuitPayGateway({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    const checkout = await gateway.createCheckout({ amountRwf: 5_000, idempotencyKey: "key-1" });
    expect(checkout).toMatchObject({ reference: "CP-1", amountRwf: 5_000, code: "8Q2F" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses to hand the user a checkout link that is not HTTPS", async () => {
    const fetchImpl = async () => jsonResponse({ reference: "CP-1", url: "http://pay.example/c/8Q2F", amount: 5_000 });
    const gateway = new CircuitPayGateway({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    await expect(gateway.createCheckout({ amountRwf: 5_000, idempotencyKey: "k" })).rejects.toThrow(/HTTPS/);
  });

  it("validates the amount before a request is ever made", async () => {
    const fetchImpl = vi.fn();
    const gateway = new CircuitPayGateway({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    await expect(gateway.createCheckout({ amountRwf: 12.5, idempotencyKey: "k" })).rejects.toThrow(BillingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads every spelling of a settled payment, and refuses one it does not know", async () => {
    const status = async (value: string) => {
      const gateway = new CircuitPayGateway({ ...options, fetch: (async () => jsonResponse({ status: value, amount: 5_000 })) as unknown as typeof fetch });
      return (await gateway.getPayment("CP-1")).status;
    };
    expect(await status("succeeded")).toBe("paid");
    expect(await status("requires_action")).toBe("pending");
    expect(await status("cancelled")).toBe("failed");
    // The dangerous default would be reading an unknown word as success.
    await expect(status("quantum")).rejects.toThrow(/does not understand/i);
  });

  it("never leaks the key into an error a user will paste somewhere", async () => {
    const gateway = new CircuitPayGateway({ ...options, fetch: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch });
    await expect(gateway.getBalance()).rejects.toThrow(/NOVA_BILLING_KEY/);
    await gateway.getBalance().catch((error: Error) => {
      expect(error.message).not.toContain(options.apiKey);
    });
  });

  it("says nothing was charged when the service is down", async () => {
    const gateway = new CircuitPayGateway({ ...options, fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    await expect(gateway.getBalance()).rejects.toThrow(/Nothing was charged/i);
  });

  it("treats a malformed success as an error rather than an empty balance", async () => {
    const gateway = new CircuitPayGateway({ ...options, fetch: (async () => jsonResponse({ balance: "1240" })) as unknown as typeof fetch });
    await expect(gateway.getBalance()).rejects.toThrow(/whole number/i);
  });

  it("is absent, not half-configured, when the environment says nothing", () => {
    expect(billingFromEnvironment({})).toBeNull();
    expect(billingFromEnvironment({ NOVA_BILLING_URL: "https://pay.example" })).toBeNull();
    expect(billingFromEnvironment({ NOVA_BILLING_KEY: "sk" })).toBeNull();
    expect(billingFromEnvironment({ NOVA_BILLING_URL: "https://pay.example", NOVA_BILLING_KEY: "sk" })).toBeInstanceOf(CircuitPayGateway);
  });
});
