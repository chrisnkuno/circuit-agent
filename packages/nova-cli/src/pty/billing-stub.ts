import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the billing service, shaped exactly like the contract `CircuitPayGateway` reads.
 *
 * It exists so the payment flow can be exercised as a whole — the confirmation, the checkout, the
 * polling, the receipt — against a real CLI process. Every part of that flow has a unit test; none
 * of them prove the command is wired into the prompt at all, which is the failure this catches.
 *
 * It also records what it was asked, because two of the properties that matter most about a payment
 * client are invisible from the outside: that nothing is created before the human confirms, and
 * that one confirmed top-up creates exactly one checkout.
 */

export type BillingStub = {
  readonly url: string;
  /** Flips the payment to paid, as if the user finished it on the checkout page. */
  markPaid(): void;
  /** Every checkout creation received, with the idempotency key it carried. */
  creations(): Array<{ amount: number; idempotencyKey: string | undefined }>;
  balanceRwf: number;
  close(): Promise<void>;
};

export async function startBillingStub(initialBalanceRwf = 1_240): Promise<BillingStub> {
  const creations: Array<{ amount: number; idempotencyKey: string | undefined }> = [];
  let status: "pending" | "paid" = "pending";
  let amount = 0;

  const stub = {
    balanceRwf: initialBalanceRwf,
    markPaid() {
      status = "paid";
      stub.balanceRwf += amount;
    },
    creations: () => creations,
  } as BillingStub;

  const server = http.createServer((request, response) => {
    const send = (body: unknown, code = 200) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = request.url ?? "";
    if (request.method === "POST" && url.startsWith("/v1/checkouts")) {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw || "{}") as { amount?: number };
        amount = body.amount ?? 0;
        creations.push({ amount, idempotencyKey: request.headers["idempotency-key"] as string | undefined });
        send({ reference: "CP-STUB-1", url: "https://pay.example/c/8Q2F-7KDA", code: "8Q2F-7KDA", amount });
      });
      return;
    }
    if (request.method === "GET" && url.startsWith("/v1/checkouts/")) {
      send({ status, amount });
      return;
    }
    if (request.method === "GET" && url.startsWith("/v1/balance")) {
      send({ balance: stub.balanceRwf, as_of: Date.now() });
      return;
    }
    send({ message: "not found" }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  Object.defineProperty(stub, "url", { value: `http://127.0.0.1:${port}`, enumerable: true });
  Object.defineProperty(stub, "close", {
    value: () => new Promise<void>((resolve) => server.close(() => resolve())),
    enumerable: true,
  });
  return stub;
}
