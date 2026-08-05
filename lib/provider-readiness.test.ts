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

  it("evaluates the explicitly selected CircuitNotion provider instead of the OpenAI defaults", () => {
    const report = assessProviderReadiness({
      convexDeployment: "dev:one",
      convexUrl: "https://example.convex.cloud",
      e2bApiKey: "e2b_key",
      e2bCodingTemplate: "circuit-coding",
      codingModelProvider: "circuitnotion",
      circuitNotionApiKey: "cn_key",
      circuitNotionModel: "circuit-3",
      modelInputRwfPerMillion: "2000",
      modelOutputRwfPerMillion: "8000",
    });
    expect(report.codingExecution).toBe(true);
    expect(report.missing).not.toContain("OPENAI_API_KEY");
    expect(report.missing).not.toContain("CIRCUITNOTION_API_KEY");
  });

  it("treats an unselected model provider as not ready even if OpenAI keys are present", () => {
    const report = assessProviderReadiness({
      convexDeployment: "dev:one",
      convexUrl: "https://example.convex.cloud",
      e2bApiKey: "e2b_key",
      e2bCodingTemplate: "circuit-coding",
      openaiApiKey: "model_key",
      openaiModel: "gpt-5.6-terra",
      modelInputRwfPerMillion: "2000",
      modelOutputRwfPerMillion: "8000",
    });
    expect(report.codingExecution).toBe(false);
    expect(report.missing).toContain("CODING_MODEL_PROVIDER");
  });

  it("requires both payment API and webhook verification", () => {
    const report = assessProviderReadiness({ convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud", circuitPayApiKey: "pay_key" });
    expect(report.payments).toBe(false);
    expect(report.missing).toContain("CIRCUIT_PAY_WEBHOOK_SECRET");
  });

  it("requires the full GitHub App credential set before repository provisioning is ready", () => {
    const incomplete = assessProviderReadiness({ convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud", githubAppId: "123" });
    expect(incomplete.repositoryProvisioning).toBe(false);
    expect(incomplete.missing).toEqual(expect.arrayContaining(["GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]));

    const complete = assessProviderReadiness({
      convexDeployment: "dev:one", convexUrl: "https://example.convex.cloud",
      githubAppId: "123", githubAppSlug: "circuit-nova", githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----", githubWebhookSecret: "whsec",
    });
    expect(complete.repositoryProvisioning).toBe(true);
  });
});
