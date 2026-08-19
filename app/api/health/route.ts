import { NextResponse } from "next/server";
import { assessProviderReadiness } from "@/lib/provider-readiness";

/** Return a non-secret placeholder when an env var is set, or undefined when absent. */
function presence(value: string | undefined): string | undefined {
  return value?.trim() ? "(set)" : undefined;
}

export function GET() {
  const readiness = assessProviderReadiness({
    convexDeployment: process.env.CONVEX_DEPLOYMENT,
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
    e2bApiKey: presence(process.env.E2B_API_KEY),
    e2bCodingTemplate: process.env.E2B_CODING_TEMPLATE,
    codingModelProvider: process.env.CODING_MODEL_PROVIDER,
    openaiApiKey: presence(process.env.OPENAI_API_KEY),
    openaiModel: process.env.OPENAI_MODEL,
    circuitNotionApiKey: presence(process.env.CIRCUITNOTION_API_KEY),
    circuitNotionModel: process.env.CIRCUITNOTION_MODEL,
    modelInputRwfPerMillion: process.env.MODEL_INPUT_RWF_PER_MILLION,
    modelOutputRwfPerMillion: process.env.MODEL_OUTPUT_RWF_PER_MILLION,
    circuitPayApiKey: presence(process.env.CIRCUIT_PAY_API_KEY),
    circuitPayWebhookSecret: process.env.CIRCUIT_PAY_WEBHOOK_SECRET,
    githubAppId: process.env.GITHUB_APP_ID,
    githubAppSlug: process.env.GITHUB_APP_SLUG,
    githubAppPrivateKey: presence(process.env.GITHUB_APP_PRIVATE_KEY),
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    exaApiKey: process.env.EXA_API_KEY,
  });
  return NextResponse.json({ ok: true, application: "up", readiness });
}
