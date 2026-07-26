import type { CodingPlan } from "../coding-prompt";

export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type CodingPlanRequest = {
  taskId: string;
  stepId: string;
  objective: string;
  repositoryContext: string;
  workspaceRoot: string;
  maxCommands: number;
  maxOutputTokens: number;
  timeoutMs: number;
  reasoningEffort: ModelReasoningEffort;
  safetyIdentifier: string;
};

export type CodingPlanResult = {
  status: "planned" | "refused";
  plan?: CodingPlan;
  refusal?: string;
  responseId: string;
  model: string;
  usage: ModelUsage;
};

export interface CodingModelProvider {
  generateCodingPlan(request: CodingPlanRequest): Promise<CodingPlanResult>;
}
