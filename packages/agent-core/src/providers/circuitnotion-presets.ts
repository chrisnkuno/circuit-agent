import OpenAI from "openai";
import { z } from "zod";
import { buildCircuitNotionHeaders, circuitNotionBaseUrl, type ChatCompletionUnaryCall } from "./circuitnotion";
import { buildDynamicPresetsPrompt, DynamicPresetsSchema, type PresetContext, type PresetSuggestion } from "../dynamic-presets";

export type CircuitNotionPresetsOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  relaySecret?: string;
};

const RETRY_INSTRUCTION = "Your previous response was not valid JSON matching the required schema. Return ONLY a single JSON object matching the schema, with no commentary, code fences, or extra text.";
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 500;

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

function tryParsePresets(content: string | null | undefined): PresetSuggestion[] | undefined {
  if (!content) return undefined;
  try {
    return DynamicPresetsSchema.parse(extractJson(content)).presets;
  } catch {
    return undefined;
  }
}

/**
 * A small, single-purpose sibling of CircuitNotionCodingModelProvider: same JSON-mode +
 * validate-and-retry-once shape, but for a cheap, unbilled suggestion call rather than a
 * billed coding plan, so it deliberately doesn't touch ModelUsage/RWF accounting at all.
 */
export class CircuitNotionPresetsProvider {
  private readonly call: ChatCompletionUnaryCall;

  constructor(private readonly options: CircuitNotionPresetsOptions, call?: ChatCompletionUnaryCall) {
    if (!options.apiKey.trim()) throw new Error("CIRCUITNOTION_API_KEY is required");
    if (!options.model.trim()) throw new Error("CIRCUITNOTION_PRESETS_MODEL is required");
    if (call) {
      this.call = call;
    } else {
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: circuitNotionBaseUrl(options.baseURL),
        defaultHeaders: buildCircuitNotionHeaders(options.relaySecret),
      });
      this.call = async (body, signal) => (await client.chat.completions.create(body, { signal })) as unknown as Awaited<ReturnType<ChatCompletionUnaryCall>>;
    }
  }

  async generate(context: PresetContext): Promise<PresetSuggestion[]> {
    const prompt = buildDynamicPresetsPrompt(context);
    const jsonSchema = JSON.stringify(z.toJSONSchema(DynamicPresetsSchema));
    const systemPrompt = [prompt.instructions, "Respond with a single JSON object matching the JSON Schema below.", "Do not rename fields or include text outside the JSON object.", jsonSchema].join("\n\n");

    const attempt = (extra?: string) => this.call({
      model: this.options.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt.input },
        ...(extra ? [{ role: "user" as const, content: extra }] : []),
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }, AbortSignal.timeout(TIMEOUT_MS));

    let response = await attempt();
    let choice = response.choices[0];
    if (!choice) throw new Error("Model response contained no choices");
    if (choice.message.refusal) throw new Error(`Model refused: ${choice.message.refusal}`);

    let presets = tryParsePresets(choice.message.content);
    if (!presets) {
      response = await attempt(RETRY_INSTRUCTION);
      choice = response.choices[0];
      if (!choice) throw new Error("Model response contained no choices");
      if (choice.message.refusal) throw new Error(`Model refused: ${choice.message.refusal}`);
      presets = tryParsePresets(choice.message.content);
      if (!presets) throw new Error("Model response did not contain valid presets after one retry");
    }
    return presets;
  }
}
