export type PaymentAuthorization = "authorized" | "payment_authorization_required";

/** One source of truth for the approval-to-dispatch handoff that previously re-queued too early. */
export function approvedRunEffect(paymentAuthorization: PaymentAuthorization) {
  return paymentAuthorization === "authorized"
    ? { runStatus: "queued" as const, shouldDispatch: true, outcome: "started" as const }
    : { runStatus: "awaiting_approval" as const, shouldDispatch: false, outcome: "payment_authorization_required" as const };
}
