import { describe, expect, it } from "vitest";
import { approvedRunEffect } from "./approval-decision";

describe("spending approval handoff", () => {
  it("queues and dispatches immediately when the hold is authorized", () => {
    expect(approvedRunEffect("authorized")).toEqual({ runStatus: "queued", shouldDispatch: true, outcome: "started" });
  });

  it("never reports a start or dispatches while payment authorization is missing", () => {
    expect(approvedRunEffect("payment_authorization_required")).toEqual({
      runStatus: "awaiting_approval",
      shouldDispatch: false,
      outcome: "payment_authorization_required",
    });
  });
});
