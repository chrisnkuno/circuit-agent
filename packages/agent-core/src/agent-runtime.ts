import { affordableOutputTokens, priceActualModelUsage, type ModelPriceCatalog } from "./model-cost";
import type { ModelUsage } from "./providers/model";

export type AgentMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type AgentToolCall = { id: string; name: string; arguments: unknown };

export type AgentModelTurn = {
  responseId: string;
  model: string;
  finishReason: "stop" | "tool_calls" | "refusal";
  content: string;
  refusal?: string;
  toolCalls: AgentToolCall[];
  usage: ModelUsage;
};

export type AgentModelRequest = {
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  maxOutputTokens: number;
  safetyIdentifier: string;
  /**
   * Called with each piece of assistant text as it is generated.
   *
   * Optional on purpose: a provider that cannot stream simply never calls it, and the finished
   * turn it returns is identical either way. That keeps streaming a rendering concern rather than
   * a second code path through the agent loop — the runtime's accounting, tool handling and stop
   * conditions all read the completed turn exactly as before.
   */
  onTextDelta?: (text: string) => void;
};

export interface AgentTurnProvider {
  complete(request: AgentModelRequest): Promise<AgentModelTurn>;
}

export type ToolEffect = "none" | "workspace" | "external";
export type VerificationEvidence = { passed: boolean; scope: "targeted" | "full"; summary: string };

export type AgentToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentToolResult = {
  content: string;
  isError?: boolean;
  verification?: VerificationEvidence;
  effect?: ToolEffect;
};

export type AgentToolContext = { taskId: string; runId: string; stepId: string };

export type AgentTool = AgentToolDefinition & {
  capabilityId: string;
  effect: ToolEffect;
  requiresApproval: boolean;
  parallelSafe: boolean;
  execute(argumentsValue: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
};

export type AgentRuntimeEvent =
  | { type: "assistant_delta"; iteration: number; text: string }
  // Usage rides along so a front end can show spend accruing during the turn. Waiting for the
  // final result means the number only appears once the money is already gone.
  | { type: "model_turn"; iteration: number; responseId: string; model: string; toolCallCount: number; usage: ModelUsage }
  // Emitted immediately before a tool runs, so a front end can say what is happening while it
  // happens rather than only what happened. The result alone cannot carry this: by the time it
  // arrives the interesting part — which file, which command — is already over.
  | { type: "tool_call"; toolCallId: string; toolName: string; effect: ToolEffect; arguments: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; toolName: string; isError: boolean; effect: ToolEffect; content: string }
  | { type: "runtime_stop"; status: AgentRuntimeResult["status"]; summary: string };

export type AgentRuntimeControl = {
  heartbeat(): Promise<void>;
  isCancellationRequested(): Promise<boolean>;
  isToolCallApproved(call: AgentToolCall, tool: AgentTool): Promise<boolean | "approved" | "denied" | "pending">;
  persistEvent(event: AgentRuntimeEvent): Promise<void>;
};

export type AgentRuntimeRequest = AgentToolContext & {
  objective: string;
  systemPrompt: string;
  /**
   * Prior, structurally complete conversation items.
   *
   * Keeping these as native messages preserves provider prompt caching and, more importantly,
   * prevents a tool result from being flattened into prose that no longer matches its call.
   * System messages are owned by the current run and are therefore not accepted here.
   */
  history?: AgentMessage[];
  allowedCapabilityIds: string[];
  maxIterations: number;
  maxToolCalls: number;
  maxToolCallsPerTurn: number;
  maxToolResultChars: number;
  maxTotalToolResultChars: number;
  maxOutputTokens: number;
  modelReservationRwf: number;
  safetyIdentifier: string;
};

export type AgentRuntimeResult = {
  status: "completed" | "failed" | "blocked" | "needs_approval" | "needs_verification" | "cancelled" | "iteration_limit";
  summary: string;
  messages: AgentMessage[];
  usage: ModelUsage;
  actualModelRwf: number;
  iterations: number;
  toolCallsExecuted: number;
};

const emptyUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function addUsage(total: ModelUsage, next: ModelUsage): ModelUsage {
  const values = Object.values(next);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model returned invalid usage accounting");
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}

function validateRequest(request: AgentRuntimeRequest): void {
  if (!request.taskId.trim() || !request.runId.trim() || !request.stepId.trim()) throw new Error("Task, run, and step identity are required");
  if (!request.objective.trim() || !request.systemPrompt.trim()) throw new Error("Objective and systemPrompt are required");
  const bounded = [
    [request.maxIterations, 1, 100, "maxIterations"],
    [request.maxToolCalls, 0, 500, "maxToolCalls"],
    [request.maxToolCallsPerTurn, 1, 16, "maxToolCallsPerTurn"],
    [request.maxToolResultChars, 128, 200_000, "maxToolResultChars"],
    [request.maxTotalToolResultChars, 128, 1_000_000, "maxTotalToolResultChars"],
    [request.maxOutputTokens, 256, 128_000, "maxOutputTokens"],
  ] as const;
  for (const [value, minimum, maximum, name] of bounded) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  if (!Number.isSafeInteger(request.modelReservationRwf) || request.modelReservationRwf < 0) throw new Error("modelReservationRwf must be a non-negative integer");
  validateHistory(request.history ?? []);
}

/** A persisted transcript may only resume at a complete provider-message boundary. */
export function validateHistory(history: readonly AgentMessage[]): void {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of history) {
    if (message.role === "system") throw new Error("Runtime history must not contain system messages");
    if (message.role === "tool") {
      const expectedName = pending.get(message.toolCallId);
      if (!expectedName) throw new Error(`Runtime history contains orphaned tool result ${message.toolCallId}`);
      if (expectedName !== message.name) throw new Error(`Runtime history tool result ${message.toolCallId} does not match ${expectedName}`);
      pending.delete(message.toolCallId);
      continue;
    }
    if (pending.size > 0) throw new Error("Runtime history contains unresolved tool calls before the next message");
    if (message.role === "assistant" && "toolCalls" in message) {
      for (const call of message.toolCalls) {
        if (!call.id.trim() || seen.has(call.id)) throw new Error(`Runtime history contains missing or duplicate tool-call id ${call.id}`);
        seen.add(call.id);
        pending.set(call.id, call.name);
      }
    }
  }
  if (pending.size > 0) throw new Error("Runtime history ends with unresolved tool calls");
}

function normalizeArguments(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function truncate(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (maximum <= 32) return value.slice(0, maximum);
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 32))}\n...[tool result truncated]`;
}

export class BoundedAgentRuntime {
  private readonly toolsByName: Map<string, AgentTool>;

  constructor(
    private readonly dependencies: { model: AgentTurnProvider; tools: AgentTool[]; control: AgentRuntimeControl; prices: ModelPriceCatalog },
  ) {
    this.toolsByName = new Map();
    for (const tool of dependencies.tools) {
      if (this.toolsByName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      if (tool.effect === "external" && !tool.requiresApproval) throw new Error(`External tool ${tool.name} must require approval`);
      if (tool.effect !== "none" && tool.parallelSafe) throw new Error(`Effectful tool ${tool.name} cannot be marked parallel-safe`);
      this.toolsByName.set(tool.name, tool);
    }
  }

  async execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    validateRequest(request);
    const capabilities = new Set(request.allowedCapabilityIds);
    const tools = [...this.toolsByName.values()].filter((tool) => capabilities.has(tool.capabilityId));
    const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const messages: AgentMessage[] = [
      { role: "system", content: request.systemPrompt },
      ...(request.history ?? []),
      { role: "user", content: request.objective },
    ];
    let usage = { ...emptyUsage };
    let actualModelRwf = 0;
    let toolCallsExecuted = 0;
    let totalToolResultChars = 0;
    let workspaceNeedsVerification = false;

    const stop = async (status: AgentRuntimeResult["status"], summary: string, iterations: number): Promise<AgentRuntimeResult> => {
      await this.dependencies.control.persistEvent({ type: "runtime_stop", status, summary });
      return { status, summary, messages, usage, actualModelRwf, iterations, toolCallsExecuted };
    };

    for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
      await this.dependencies.control.heartbeat();
      if (await this.dependencies.control.isCancellationRequested()) return stop("cancelled", "Run cancelled at a safe checkpoint.", iteration - 1);

      const approvedRemaining = request.modelReservationRwf - actualModelRwf;
      const maximumOutputTokens = affordableOutputTokens(
        [...messages.map((message) => message.content), JSON.stringify(definitions)],
        request.maxOutputTokens,
        Math.max(0, approvedRemaining),
        this.dependencies.prices,
      );
      if (maximumOutputTokens < 1) return stop("iteration_limit", "Run reached its approved model budget before another provider call.", iteration - 1);

      const turn = await this.dependencies.model.complete({
        messages: [...messages],
        tools: definitions,
        maxOutputTokens: maximumOutputTokens,
        safetyIdentifier: request.safetyIdentifier,
        // Deltas are fire-and-forget: a slow consumer must never stall generation, and a lost
        // delta costs nothing because the completed turn is still the source of truth.
        onTextDelta: (text) => void this.dependencies.control.persistEvent({ type: "assistant_delta", iteration, text }),
      });
      usage = addUsage(usage, turn.usage);
      actualModelRwf = priceActualModelUsage(usage.inputTokens, usage.outputTokens, this.dependencies.prices);
      if (actualModelRwf > request.modelReservationRwf) throw new Error("Actual model usage exceeds the reserved model budget");
      await this.dependencies.control.persistEvent({ type: "model_turn", iteration, responseId: turn.responseId, model: turn.model, toolCallCount: turn.toolCalls.length, usage: turn.usage });

      if (turn.finishReason === "refusal") return stop("blocked", turn.refusal?.trim() || "Model refused the task.", iteration);
      if (turn.finishReason === "stop") {
        const summary = turn.content.trim() || "Model completed without a summary.";
        messages.push({ role: "assistant", content: summary });
        return workspaceNeedsVerification
          // The gate must lead — this is not a success, and a reader skimming the ledger has to see
          // that first. But replacing the summary outright threw away the only account of what the
          // run actually did, which is the thing a person needs in order to decide what to do next.
          ? stop("needs_verification", `Workspace changes were made without passing verification evidence. The agent reported: ${summary}`, iteration)
          : stop("completed", summary, iteration);
      }
      if (turn.finishReason !== "tool_calls" || turn.toolCalls.length === 0) return stop("failed", "Model returned an invalid tool-call turn.", iteration);
      if (turn.toolCalls.length > request.maxToolCallsPerTurn) return stop("failed", "Model exceeded the per-turn tool-call limit.", iteration);
      if (toolCallsExecuted + turn.toolCalls.length > request.maxToolCalls) return stop("iteration_limit", "Run reached its tool-call budget.", iteration);

      const prepared: Array<{ call: AgentToolCall; tool: AgentTool; argumentsValue: Record<string, unknown> }> = [];
      const seenCallIds = new Set<string>();
      for (const call of turn.toolCalls) {
        if (!call.id.trim() || seenCallIds.has(call.id)) return stop("failed", "Model returned a missing or duplicate tool-call identifier.", iteration);
        seenCallIds.add(call.id);
        const tool = this.toolsByName.get(call.name);
        if (!tool || !capabilities.has(tool.capabilityId)) return stop("failed", `Tool ${call.name} is outside the run capability scope.`, iteration);
        const argumentsValue = normalizeArguments(call.arguments);
        if (!argumentsValue) return stop("failed", `Tool ${call.name} arguments must be a JSON object.`, iteration);
        if (tool.requiresApproval) {
          const approval = await this.dependencies.control.isToolCallApproved(call, tool);
          if (approval !== true && approval !== "approved") {
            return approval === "denied"
              ? stop("blocked", `Tool ${call.name} was rejected by the user.`, iteration)
              : stop("needs_approval", `Tool ${call.name} requires approval before execution.`, iteration);
          }
        }
        prepared.push({ call, tool, argumentsValue });
      }

      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      const runOne = async ({ call, tool, argumentsValue }: (typeof prepared)[number]) => {
        if (await this.dependencies.control.isCancellationRequested()) return { call, tool, result: { content: "Tool execution cancelled before start.", isError: true } as AgentToolResult };
        // Announced before the work, not after: a read of a large file or a long-running command
        // is exactly the moment a person needs to know what is being waited on.
        await this.dependencies.control.persistEvent({ type: "tool_call", toolCallId: call.id, toolName: call.name, effect: tool.effect, arguments: argumentsValue });
        try {
          return { call, tool, result: await tool.execute(argumentsValue, request) };
        } catch (error) {
          return { call, tool, result: { content: error instanceof Error ? error.message : "Tool execution failed", isError: true } as AgentToolResult };
        }
      };
      const canRunInParallel = prepared.length > 1 && prepared.every(({ tool }) => tool.parallelSafe && tool.effect === "none");
      const results = canRunInParallel ? await Promise.all(prepared.map(runOne)) : [];
      if (!canRunInParallel) for (const item of prepared) results.push(await runOne(item));

      for (const { call, tool, result } of results) {
        toolCallsExecuted += 1;
        const remaining = request.maxTotalToolResultChars - totalToolResultChars;
        const content = truncate(result.content || "(empty tool result)", Math.max(0, Math.min(request.maxToolResultChars, remaining)));
        totalToolResultChars += content.length;
        messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
        const effect = tool.effect === "external" ? "external" : result.effect ?? tool.effect;
        if (!result.isError && effect === "workspace") workspaceNeedsVerification = true;
        if (!result.isError && result.verification?.passed) workspaceNeedsVerification = false;
        await this.dependencies.control.persistEvent({ type: "tool_result", toolCallId: call.id, toolName: call.name, isError: result.isError ?? false, effect, content });
      }
      if (totalToolResultChars >= request.maxTotalToolResultChars) return stop("iteration_limit", "Run reached its total tool-result context budget.", iteration);
    }
    return stop("iteration_limit", "Run reached its model iteration budget.", request.maxIterations);
  }
}
