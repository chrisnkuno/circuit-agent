import { NextResponse } from "next/server";
import { assessProviderReadiness } from "@/lib/provider-readiness";

export function GET() {
  const readiness = assessProviderReadiness({
    convexDeployment: process.env.CONVEX_DEPLOYMENT,
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
    e2bApiKey: process.env.E2B_API_KEY,
    e2bCodingTemplate: process.env.E2B_CODING_TEMPLATE,
    codingModelProvider: process.env.CODING_MODEL_PROVIDER,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL,
    circuitNotionApiKey: process.env.CIRCUITNOTION_API_KEY,
    circuitNotionModel: process.env.CIRCUITNOTION_MODEL,
    modelInputRwfPerMillion: process.env.MODEL_INPUT_RWF_PER_MILLION,
    modelOutputRwfPerMillion: process.env.MODEL_OUTPUT_RWF_PER_MILLION,
    circuitPayApiKey: process.env.CIRCUIT_PAY_API_KEY,
    circuitPayWebhookSecret: process.env.CIRCUIT_PAY_WEBHOOK_SECRET,
    githubAppId: process.env.GITHUB_APP_ID,
    githubAppSlug: process.env.GITHUB_APP_SLUG,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  });
  return NextResponse.json({ ok: true, application: "up", readiness });
}
