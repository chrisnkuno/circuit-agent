import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { buildCodingPlannerPrompt, CodingPlanSchema, type CodingPlan } from "../coding-prompt";
import type { CodingModelProvider, CodingPlanRequest, CodingPlanResult, GenerateCodingPlanOptions, ModelUsage } from "./model";
import { PROTOCOL_MAX_OUTPUT_TOKENS } from "./model-capabilities";

type ParsedCodingResponse = {
  id: string;
  model: string;
  status: string;
  output_parsed: CodingPlan | null;
  output: Array<{ type: string; content?: Array<{ type: string; refusal?: string }> }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

type ResponseBody = Parameters<OpenAI["responses"]["parse"]>[0];
type ResponseCall = (body: ResponseBody, signal: AbortSignal) => Promise<ParsedCodingResponse>;

export type OpenAICodingModelOptions = {
  apiKey: string;
  model: string;
};

function validateRequest(request: CodingPlanRequest): void {
  if (!request.taskId.trim() || !request.stepId.trim()) throw new Error("taskId and stepId are required");
  // The ceiling is the largest output any current model will produce, not a number this file
  // invented. Whether *this* model can go that high is decided upstream from its capabilities
  // (`model-capabilities.ts`); a validator that cannot see the model must not impose a stricter
  // limit than the protocol, which is what the old 16,384 did — it rejected the runtime's own
  // default the moment budgets started coming from the model.
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 256 || request.maxOutputTokens > PROTOCOL_MAX_OUTPUT_TOKENS) {
    throw new Error(`maxOutputTokens must be between 256 and ${PROTOCOL_MAX_OUTPUT_TOKENS}`);
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 10 * 60_000) {
    throw new Error("timeoutMs must be between 1 second and 10 minutes");
  }
  if (!request.safetyIdentifier.trim() || request.safetyIdentifier.length > 64) throw new Error("safetyIdentifier must contain 1 to 64 characters");
}

function normalizeUsage(response: ParsedCodingResponse): ModelUsage {
  if (!response.usage) throw new Error("Model response did not include usage accounting");
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.total_tokens,
    cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: response.usage.input_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model response contained invalid usage accounting");
  return usage;
}

/** OpenAI Responses API adapter using code-versioned prompts and Structured Outputs. */
export class OpenAICodingModelProvider implements CodingModelProvider {
  private readonly call: ResponseCall;

  constructor(private readonly options: OpenAICodingModelOptions, call?: ResponseCall) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!options.model.trim()) throw new Error("OPENAI_MODEL is required");
    if (call) {
      this.call = call;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
      this.call = async (body, signal) => client.responses.parse(body, { signal }) as unknown as ParsedCodingResponse;
    }
  }

  // The Responses API path resolves in one shot, so there is no stream to report progress from;
  // `options` is accepted for contract parity and deliberately unused.
  async generateCodingPlan(request: CodingPlanRequest, _options?: GenerateCodingPlanOptions): Promise<CodingPlanResult> {
    validateRequest(request);
    const prompt = buildCodingPlannerPrompt(request);
    const response = await this.call({
      model: this.options.model,
      instructions: prompt.instructions,
      input: prompt.input,
      max_output_tokens: request.maxOutputTokens,
      reasoning: { effort: request.reasoningEffort },
      text: { format: zodTextFormat(CodingPlanSchema, "coding_plan") },
      metadata: { task_id: request.taskId, step_id: request.stepId, prompt_version: "coding-planner-v1" },
      prompt_cache_key: "circuit-nova-coding-planner-v1",
      safety_identifier: request.safetyIdentifier,
      store: false,
    }, AbortSignal.timeout(request.timeoutMs));

    const usage = normalizeUsage(response);
    if (response.status !== "completed") throw new Error(`Model response ended with status ${response.status}`);
    if (response.output_parsed) {
      return { status: "planned", plan: CodingPlanSchema.parse(response.output_parsed), responseId: response.id, model: response.model, usage };
    }
    const refusal = response.output
      .flatMap((item) => item.content ?? [])
      .find((content) => content.type === "refusal")
      ?.refusal;
    if (refusal) return { status: "refused", refusal, responseId: response.id, model: response.model, usage };
    throw new Error("Model response contained neither a coding plan nor a refusal");
  }
}
