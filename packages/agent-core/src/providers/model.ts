import type { CodingPlan } from "../coding-prompt";

export type ModelReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /** Hard ceiling on the whole model call, however much of it is streaming. */
  timeoutMs: number;
  /**
   * How long a streaming call may go without producing a token before it is abandoned.
   *
   * A total-request deadline cannot tell "the model is still writing a long plan" apart from
   * "the connection is dead", so a large notebook and a hung socket look identical and both get
   * killed. Silence is the honest signal. Adapters that cannot stream ignore this.
   */
  idleTimeoutMs?: number;
  reasoningEffort: ModelReasoningEffort;
  safetyIdentifier: string;
  /** Programs the chosen workspace image ships, so the planner is offered only tools that exist. */
  templatePrograms?: readonly string[];
  /**
   * Files written into the sandbox before the plan's own fileChanges (e.g. Wander Exa briefing).
   * Paths are relative to workspaceRoot.
   */
  workspaceSeedFiles?: Array<{ path: string; content: string }>;
  /**
   * What went wrong last time, when this request is a repair rather than a first attempt. The
   * planner cannot fix a mistake it is never shown, and a fresh plan for the same objective
   * usually reproduces the same mistake.
   */
  previousFailure?: PreviousAttemptFailure;
};

export type PreviousAttemptFailure = {
  /** The plan's own description of what it was trying to do. */
  intent: string;
  command: string;
  exitCode: number;
  output: string;
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
