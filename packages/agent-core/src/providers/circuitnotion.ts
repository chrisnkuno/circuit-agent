import OpenAI from "openai";
import { z } from "zod";
import { buildCodingPlannerPrompt, CodingPlanSchema } from "../coding-prompt";
import { buildCircuitNotionHeaders, circuitNotionBaseUrl } from "./circuitnotion-http";
import type { CodingModelProvider, CodingPlanRequest, CodingPlanResult, GenerateCodingPlanOptions, ModelUsage } from "./model";
import { PROTOCOL_MAX_OUTPUT_TOKENS } from "./model-capabilities";
import { estimateTextTokens } from "../model-cost";

export { CIRCUITNOTION_DEFAULT_BASE_URL, buildCircuitNotionHeaders, circuitNotionBaseUrl } from "./circuitnotion-http";

export type ChatCompletionResponse = {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string | null;
    message: { content: string | null; refusal?: string | null };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

/** One server-sent chunk of a streamed completion. Every field is absent on some chunk. */
export type ChatCompletionChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: string | null; refusal?: string | null };
  }>;
  usage?: ChatCompletionResponse["usage"];
};

export type ChatCompletionBody = Parameters<OpenAI["chat"]["completions"]["create"]>[0];
/** Streaming call, used where a response can outlive the relay's buffered-response ceiling. */
export type ChatCompletionCall = (body: ChatCompletionBody, signal: AbortSignal) => Promise<AsyncIterable<ChatCompletionChunk>>;
/** One-shot call, for short prompts (preset suggestions) that always answer well inside it. */
export type ChatCompletionUnaryCall = (body: ChatCompletionBody, signal: AbortSignal) => Promise<ChatCompletionResponse>;

/** Silence, not total elapsed time, is what distinguishes a dead connection from a long plan. */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

export type CircuitNotionCodingModelOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  relaySecret?: string;
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
  if (request.idleTimeoutMs !== undefined && (!Number.isInteger(request.idleTimeoutMs) || request.idleTimeoutMs < 1_000 || request.idleTimeoutMs > request.timeoutMs)) {
    throw new Error("idleTimeoutMs must be between 1 second and timeoutMs");
  }
}

/**
 * Folds a streamed completion back into the single response shape the rest of the adapter reads,
 * abandoning the call only when the stream goes quiet for `idleTimeoutMs`.
 *
 * Streaming is what makes a long lab plan possible at all: Convex reaches CircuitNotion through a
 * Cloudflare Worker relay, and a single buffered response is commonly cut around 90 seconds, so a
 * notebook that takes two minutes to write could never be received no matter how long the client
 * was willing to wait. Tokens arriving keep the connection alive and prove the model is working.
 */
export async function collectCompletionStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  idleTimeoutMs: number,
  onStall: (elapsedMs: number) => void,
  onDelta?: (receivedChars: number) => void,
): Promise<ChatCompletionResponse> {
  let id = "";
  let model = "";
  let content = "";
  let refusal = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse["usage"] = null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onStall(idleTimeoutMs), idleTimeoutMs);
  };

  try {
    arm();
    for await (const chunk of stream) {
      arm();
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        content += choice.delta.content;
        onDelta?.(content.length);
      }
      if (choice.delta?.refusal) refusal += choice.delta.refusal;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    id,
    model,
    choices: [{ finish_reason: finishReason, message: { content: content || null, refusal: refusal || null } }],
    usage,
  };
}

function normalizeUsage(response: ChatCompletionResponse, fallback: { input: string; maxOutputTokens: number }): ModelUsage {
  // Some CircuitNotion-compatible upstreams omit the final usage-only SSE chunk under concurrent
  // load even when include_usage was requested. A complete, schema-valid plan should not be thrown
  // away for that transport omission. Charge the entire requested output allowance (which includes
  // hidden reasoning) plus a conservative local input estimate, so the fallback can only
  // over-account, never silently make unmetered work free.
  if (!response.usage) {
    const inputTokens = estimateTextTokens(fallback.input) + 64;
    return {
      inputTokens,
      outputTokens: fallback.maxOutputTokens,
      totalTokens: inputTokens + fallback.maxOutputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
  }
  const usage = {
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
    cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model response contained invalid usage accounting");
  return usage;
}

function sumUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // fall through to brace extraction below
  }
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model response did not contain a JSON object");
  return JSON.parse(match[0]);
}

function parsePlan(content: string | null) {
  if (!content) return undefined;
  try {
    return CodingPlanSchema.parse(extractJson(content));
  } catch {
    return undefined;
  }
}

/**
 * Why a plan request ended without a plan.
 *
 * A plan is a single JSON object, so unlike a conversational turn there is nothing to salvage from
 * a truncated one — half an object is not a smaller plan. What the caller can act on is *which*
 * limit was hit, and the raw `finish_reason` does not say: "length" reads like a network word.
 *
 * The obvious advice — "raise the budget" — is mostly a dead end, and saying so is the point of
 * this message. The step plans and builds serially inside one Convex action that is killed at ten
 * minutes, so the allowance is bounded by the time left after the sandbox gets its bench: roughly
 * 36K tokens. Chasing 8K -> 16K -> 32K already consumed that headroom. Past this point the plan
 * has to get smaller, not the budget bigger.
 */
function planEndingError(reason: string | null, maxOutputTokens: number): string {
  return reason === "length" || reason === "max_tokens"
    ? `Model ran out of output budget (${maxOutputTokens} tokens) before finishing the plan JSON. This objective is too large to plan in one step — narrow it or split it, rather than raising maxOutputTokens, which is already near the ceiling the step deadline allows.`
    : `Model response ended with finish reason ${reason}`;
}

const RETRY_INSTRUCTION = "Your previous response was not valid JSON matching the required schema. Return ONLY a single JSON object matching the schema, with no commentary, code fences, or extra text.";

/**
 * CircuitNotion adapter using Chat Completions (JSON mode + Zod validate-and-retry).
 * CircuitNotion's API is OpenAI SDK compatible but only documents Chat Completions,
 * not the Responses API or native Structured Outputs used by the OpenAI adapter.
 */
export class CircuitNotionCodingModelProvider implements CodingModelProvider {
  private readonly call: ChatCompletionCall;

  constructor(private readonly options: CircuitNotionCodingModelOptions, call?: ChatCompletionCall) {
    if (!options.apiKey.trim()) throw new Error("CIRCUITNOTION_API_KEY is required");
    if (!options.model.trim()) throw new Error("CIRCUITNOTION_MODEL is required");
    if (call) {
      this.call = call;
    } else {
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: circuitNotionBaseUrl(options.baseURL),
        defaultHeaders: buildCircuitNotionHeaders(options.relaySecret),
      });
      this.call = async (body, signal) => (await client.chat.completions.create(body, { signal })) as unknown as AsyncIterable<ChatCompletionChunk>;
    }
  }

  async generateCodingPlan(request: CodingPlanRequest, options?: GenerateCodingPlanOptions): Promise<CodingPlanResult> {
    validateRequest(request);
    const prompt = buildCodingPlannerPrompt(request);
    const jsonSchema = JSON.stringify(z.toJSONSchema(CodingPlanSchema));
    const systemPrompt = [
      prompt.instructions,
      "Respond with a single JSON object matching the JSON Schema below.",
      "Do not rename fields or include text outside the JSON object.",
      jsonSchema,
    ].join("\n\n");

    const idleTimeoutMs = Math.min(request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, request.timeoutMs);

    const attempt = async (extra?: string) => {
      // Aborting the request is what actually ends a stalled read; the flag is only so the
      // failure reports the real reason instead of a generic AbortError.
      const stall = new AbortController();
      let stalledForMs = 0;
      const stream = await this.call({
        model: this.options.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt.input },
          ...(extra ? [{ role: "user" as const, content: extra }] : []),
        ],
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        response_format: { type: "json_object" },
        stream: true,
        // Streamed responses omit usage unless asked, and a plan whose cost cannot be
        // accounted for must not be executed.
        stream_options: { include_usage: true },
      }, AbortSignal.any([AbortSignal.timeout(request.timeoutMs), stall.signal]));

      try {
        return await collectCompletionStream(stream, idleTimeoutMs, (elapsedMs) => {
          stalledForMs = elapsedMs;
          stall.abort();
        }, options?.onProgress ? (receivedChars) => options.onProgress?.({ receivedChars }) : undefined);
      } catch (error) {
        if (stalledForMs > 0) throw new Error(`Model stream produced no output for ${Math.round(stalledForMs / 1_000)}s and was abandoned`);
        throw error;
      }
    };

    let response = await attempt();
    let usage = normalizeUsage(response, { input: `${systemPrompt}\n\n${prompt.input}`, maxOutputTokens: request.maxOutputTokens });
    let choice = response.choices[0];
    if (!choice) throw new Error("Model response contained no choices");
    if (choice.message.refusal) return { status: "refused", refusal: choice.message.refusal, responseId: response.id, model: response.model, usage };
    // An unstated reason (`null`) is not evidence of a bad ending — `parsePlan` below is the real
    // check, and it rejects the truncated JSON a genuinely cut-off response would carry.
    if (choice.finish_reason !== null && choice.finish_reason !== "stop") throw new Error(planEndingError(choice.finish_reason, request.maxOutputTokens));

    let plan = parsePlan(choice.message.content);
    if (!plan) {
      response = await attempt(RETRY_INSTRUCTION);
      usage = sumUsage(usage, normalizeUsage(response, { input: `${systemPrompt}\n\n${prompt.input}\n\n${RETRY_INSTRUCTION}`, maxOutputTokens: request.maxOutputTokens }));
      choice = response.choices[0];
      if (!choice) throw new Error("Model response contained no choices");
      if (choice.message.refusal) return { status: "refused", refusal: choice.message.refusal, responseId: response.id, model: response.model, usage };
      if (choice.finish_reason !== null && choice.finish_reason !== "stop") throw new Error(planEndingError(choice.finish_reason, request.maxOutputTokens));
      plan = parsePlan(choice.message.content);
      if (!plan) throw new Error("Model response did not contain a coding plan matching the required schema after one retry");
    }

    return { status: "planned", plan, responseId: response.id, model: response.model, usage };
  }
}
