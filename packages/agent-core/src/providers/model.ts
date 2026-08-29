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
  /**
   * Set when an earlier attempt at this same step ran out of its time budget mid-build and was
   * checkpointed. The workspace already holds partial work; the planner must continue it — run the
   * remaining verification/build commands and fix failures — not re-scaffold from an empty tree.
   * Carries a short note on how far the earlier attempt got.
   */
  resumeContext?: string;
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

export type CodingPlanProgress = {
  /** Characters of model output received so far. The plan is one JSON object, so this only ever grows. */
  receivedChars: number;
};

export type GenerateCodingPlanOptions = {
  /**
   * Called as plan output streams in, so a caller can show that the model is working rather than
   * a blank "provisioning" state for the minute-plus a detailed plan takes. Best-effort: adapters
   * that cannot stream (the OpenAI Responses path) never call it, and a throwing callback is the
   * caller's problem, not the request's.
   */
  onProgress?: (progress: CodingPlanProgress) => void;
};

export interface CodingModelProvider {
  generateCodingPlan(request: CodingPlanRequest, options?: GenerateCodingPlanOptions): Promise<CodingPlanResult>;
}
