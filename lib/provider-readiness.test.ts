import { describe, expect, it } from "vitest";
import { assessProviderReadiness } from "./provider-readiness";

describe("provider readiness", () => {
  it("does not claim coding execution when a model credential is absent", () => {
    const report = assessProviderReadiness({ convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud", e2bApiKey: "e2b_key", e2bCodingTemplate: "circuit-coding" });
    expect(report.controlPlane).toBe(true);
    expect(report.codingExecution).toBe(false);
    expect(report.missing).toContain("OPENAI_API_KEY");
  });

  it("requires an approved coding sandbox template", () => {
    const report = assessProviderReadiness({ convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud", e2bApiKey: "e2b_key", openaiApiKey: "model_key" });
    expect(report.codingExecution).toBe(false);
    expect(report.missing).toContain("E2B_CODING_TEMPLATE");
  });

  it("requires versioned model identity and RWF price inputs before execution", () => {
    const report = assessProviderReadiness({
      convexDeployment: "dev:one",
      convexUrl: "https://example.convex.cloud",
      e2bApiKey: "e2b_key",
      e2bCodingTemplate: "circuit-coding",
      openaiApiKey: "model_key",
    });
    expect(report.codingExecution).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(["OPENAI_MODEL", "MODEL_INPUT_RWF_PER_MILLION", "MODEL_OUTPUT_RWF_PER_MILLION"]));
  });

  it("requires both payment API and webhook verification", () => {
    const report = assessProviderReadiness({ convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud", circuitPayApiKey: "pay_key" });
    expect(report.payments).toBe(false);
    expect(report.missing).toContain("CIRCUIT_PAY_WEBHOOK_SECRET");
  });
});
