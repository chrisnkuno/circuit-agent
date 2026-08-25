/**
 * Provider-neutral bounded tool loop: accounts for every prompt-bearing part, enforces money and
 * iteration limits, executes approved tools, and keeps oversized results out of the transcript.
 */
import { addPart, affordableOutputTokensFor, newPartTotals, priceActualModelUsage, tokenEstimateFrom, type ModelPriceCatalog } from "./model-cost";
import type { ModelUsage } from "./providers/model";
import type { ModelCapabilities } from "./providers/model-capabilities";
import { createHash } from "node:crypto";

export type AgentMessage =
  | { role: "system" | "user" | "assistant"; content: string; internal?: boolean }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[]; internal?: boolean }
  | { role: "tool"; content: string; toolCallId: string; name: string; internal?: boolean };

export type AgentToolCall = { id: string; name: string; arguments: unknown };

/** Prompt-bearing parts of one message, including structured tool calls that are not in content. */
export function agentMessagePromptParts(message: AgentMessage): string[] {
  const parts = [message.content ?? ""];
  if ("toolCalls" in message && Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) parts.push(call.id, call.name, JSON.stringify(call.arguments ?? {}));
  } else if (message.role === "tool") {
    // Small, but present on every provider wire and numerous in a tool-heavy run.
    parts.push(message.toolCallId, message.name);
  }
  return parts;
}

export type AgentModelTurn = {
  responseId: string;
  model: string;
  /**
   * Why the model stopped generating.
   *
   * `length` is the one that is easy to mistake for an error: the request succeeded, the model
   * simply ran out of the output budget it was given (`finish_reason: "length"` on the Chat
   * Completions wire, `stop_reason: "max_tokens"` on Anthropic's). The text that arrived is real
   * and already paid for — it is just unfinished, so the runtime continues the turn instead of
   * failing it.
   */
  finishReason: "stop" | "tool_calls" | "refusal" | "length";
  content: string;
  refusal?: string;
  toolCalls: AgentToolCall[];
  usage: ModelUsage;
};

/** How hard the model should think, where the provider's model supports being told. */
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentModelRequest = {
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  maxOutputTokens: number;
  safetyIdentifier: string;
  /** Cancels the in-flight provider request, not merely the next runtime checkpoint. */
  signal?: AbortSignal;
  /**
   * Called with each piece of assistant text as it is generated.
   *
   * Optional on purpose: a provider that cannot stream simply never calls it, and the finished
   * turn it returns is identical either way. That keeps streaming a rendering concern rather than
   * a second code path through the agent loop — the runtime's accounting, tool handling and stop
   * conditions all read the completed turn exactly as before.
   */
  onTextDelta?: (text: string) => void;
  /**
   * How hard the model should think about this particular request.
   *
   * Set only where the *caller* knows the work is cheap: summarizing a transcript is reading, not
   * reasoning, and paying deep-thinking tokens for it is money for nothing. Left unset for ordinary
   * turns, where the provider's own default (high) is the right answer and second-guessing it costs
   * quality on exactly the requests that need it. A provider whose model does not accept the
   * setting ignores it rather than failing — see `ModelCapabilities.supportsEffort`.
   */
  effort?: ThinkingEffort;
};

export interface AgentTurnProvider {
  complete(request: AgentModelRequest): Promise<AgentModelTurn>;
  /**
   * What this provider's model can hold and produce, when it knows.
   *
   * Optional so an embedder's own provider keeps working untouched, and so a provider that cannot
   * answer says nothing rather than guessing — a caller reading this treats absence as "use the
   * conservative default", which is what every caller did before the field existed.
   */
  readonly capabilities?: ModelCapabilities;
}

export type ToolEffect = "none" | "workspace" | "external";
/**
 * How strong a piece of verification evidence is, as a ladder.
 *
 * Each rung answers a question the one below it cannot, which is the whole reason there is more
 * than one:
 *
 * - `check` — a build, typecheck or lint. Proves the code is *well-formed*. Says nothing about
 *   whether it does the right thing.
 * - `tests` — executed unit tests, including the invariant tests this codebase asks for. Proves
 *   the *units* behave, over the properties that must hold for every valid input.
 * - `smoke` — the assembled thing was started and exercised directly: the route answered, the CLI
 *   ran, the entry point rendered. Cheap and shallow, but it proves the program *works at all*
 *   when assembled, which no unit test establishes.
 * - `behavior` — an integration or end-to-end suite. Everything smoke proves, asserted across a
 *   real user path rather than a single probe.
 *
 * The top two exist because passing units are routinely assembled into something broken. A
 * component whose every invariant holds is still useless if it was never mounted, if the route was
 * never registered, or if the build output does not load in a browser — and unit tests cannot see
 * any of that by construction, because they never assemble the program.
 *
 * Ordered deliberately, and compared through `EVIDENCE_RANK` rather than by string, so "did this
 * run produce stronger evidence than that one" is one comparison rather than a chain of cases.
 * Optional so a caller that cannot classify its own command still reports verification, read as
 * `check` — the conservative reading, since claiming a build proved behaviour is the error worth
 * avoiding.
 */
export type VerificationKind = "check" | "tests" | "smoke" | "behavior";

export const EVIDENCE_RANK: Record<VerificationKind, number> = { check: 1, tests: 2, smoke: 3, behavior: 4 };

export type VerificationEvidence = { passed: boolean; kind?: VerificationKind; scope: "targeted" | "full"; summary: string };

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
  /**
   * The facts behind `content`, structured.
   *
   * `content` is prose written for a model to read — "Wrote src/app.ts (412 bytes)." — and prose is
   * a bad thing to compare or assert against: a reworded sentence breaks every test that mentioned
   * it, while a changed number hides inside one. `data` carries the same result as values, so a
   * caller (a golden-event suite, a UI, another program) can read what happened without parsing
   * English, and `content` stays free to be rewritten for the model's benefit alone.
   *
   * Optional: a tool whose result has no structure worth naming — a fetched web page — omits it.
   */
  data?: Record<string, unknown>;
};

export type AgentToolContext = { taskId: string; runId: string; stepId: string; signal?: AbortSignal };

/**
 * Where a tool came from: Nova's own fixed set, or something loaded at runtime.
 *
 * Optional and absent on every built-in tool literal — adding a required field to every entry in
 * `createNovaTools` for a distinction only externally-sourced tools need would be exactly the kind
 * of change-everywhere-to-say-nothing this codebase avoids. Absent is read as `{ kind: "built-in" }`
 * everywhere provenance is consulted (see `actionDigest` in permissions.ts).
 */
export type ToolProvenance =
  | { kind: "built-in" }
  | { kind: "skill" | "mcp" | "plugin"; providerId: string };

export type AgentTool = AgentToolDefinition & {
  capabilityId: string;
  effect: ToolEffect;
  requiresApproval: boolean;
  parallelSafe: boolean;
  provenance?: ToolProvenance;
  execute(argumentsValue: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
};

export type AgentRuntimeEvent =
  | { type: "assistant_delta"; iteration: number; text: string }
  // A retry must be visible while it is happening. Otherwise a transient outage looks exactly
  // like Nova has frozen, and Ctrl+C becomes the only feedback mechanism the user can discover.
  | { type: "provider_retry"; iteration: number; nextAttempt: number; maxAttempts: number; delayMs: number; reason: ProviderFailureKind }
  // Usage rides along so a front end can show spend accruing during the turn. Waiting for the
  // final result means the number only appears once the money is already gone.
  | { type: "model_turn"; iteration: number; responseId: string; model: string; toolCallCount: number; usage: ModelUsage }
  // Emitted immediately before a tool runs, so a front end can say what is happening while it
  // happens rather than only what happened. The result alone cannot carry this: by the time it
  // arrives the interesting part — which file, which command — is already over.
  | { type: "tool_call"; toolCallId: string; toolName: string; effect: ToolEffect; arguments: Record<string, unknown> }
  // `content` is truncated to fit the context budget and is written for the model; `data` is the
  // same result as values, untruncated, for a consumer that needs to act on it rather than read it.
  // `artifact` is present when the result was too large for the transcript and was written to a
  // file instead: `content` is then the bounded excerpt, and the artifact says where the rest is.
  | { type: "tool_result"; toolCallId: string; toolName: string; isError: boolean; effect: ToolEffect; content: string; data?: Record<string, unknown>; artifact?: StoredToolArtifact }
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
  /**
   * Effort for every model call in this run.
   *
   * A property of the *run*, not of a turn: a bounded sub-task delegated to a sub-agent is cheap
   * work throughout, and a main session's turns are not. Unset means the provider's own default.
   */
  effort?: ThinkingEffort;
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

/** How many times a turn is sent back to the model to verify before the gate gives up and stops. */
const MAX_VERIFICATION_NUDGES = 1;
const MAX_UNAVAILABLE_TOOL_RECOVERIES = 1;
/** Provider calls are safe to retry here because no tool from the returned turn has run yet. */
const MAX_PROVIDER_RETRIES = 2;
/** A malformed tool turn is model output, so let the model repair it before failing the run. */
const MAX_TOOL_TURN_RECOVERIES = 2;

export type ProviderFailureKind = "timeout" | "rate_limit" | "server" | "network" | "unknown";

/**
 * Adds retry context without discarding the provider's original error shape.
 *
 * The cause remains available to the CLI's HTTP/network classifier, while `attempts` explains why
 * Nova stopped and `retrySuppressed` explains the important partial-stream case where repeating a
 * request could duplicate paid output or tool intent.
 */
export class ProviderRequestError extends Error {
  readonly attempts: number;
  readonly retrySuppressed: "output_started" | null;

  constructor(cause: unknown, options: { attempts: number; retrySuppressed?: "output_started" }) {
    const original = cause instanceof Error ? cause.message : String(cause);
    const detail = options.retrySuppressed === "output_started"
      ? "The model connection failed after output began, so Nova did not retry to avoid duplicated output, charges, or tool actions."
      : `The model request failed after ${options.attempts} attempt${options.attempts === 1 ? "" : "s"}.`;
    super(`${detail} Provider message: ${original}`, { cause });
    this.name = "ProviderRequestError";
    this.attempts = options.attempts;
    this.retrySuppressed = options.retrySuppressed ?? null;
  }
}

/**
 * How many times a truncated turn is resumed before the run gives up.
 *
 * Bounded because "continue" is not guaranteed to converge: a model that answers every
 * continuation with another full budget of output would otherwise spend the whole task cap on one
 * unfinishable answer. Three is enough for the ordinary case — a long file, a long plan — and few
 * enough that a runaway is caught while there is still budget left to report it.
 */
const MAX_LENGTH_CONTINUATIONS = 3;

/**
 * Sent after a turn that stopped at the output cap.
 *
 * The partial text stays in the transcript above this message, so "continue" is literal: the model
 * reads what it already wrote and picks up from there. It is also told what happened, because the
 * useful correction is usually the model's own — answer more briefly, or read the file in pieces —
 * and a model that does not know it was cut off cannot make it.
 */
const LENGTH_CONTINUATION_NUDGE =
  "Your previous message hit the output token limit and was cut off mid-answer. Continue from exactly where it stopped — do not repeat what you already wrote, and do not restart. If you were part-way through a tool call, send that tool call again from the beginning, since the truncated one was discarded. If the remaining work does not fit in one reply, do the part that fits and keep each reply shorter.";

const VERIFICATION_NUDGE =
  "You changed the workspace but ended the turn without running anything that verifies it. Run the smallest relevant existing test, check, or smoke command and report the real result. Add a regression test only when the change would otherwise be unprotected. If this project genuinely has nothing relevant to run, say so explicitly instead of stopping silently.";

/**
 * Sent when the only evidence was a build, typecheck or lint.
 *
 * A passing compile is real but says nothing about behaviour, and accepting it as proof is how an
 * agent reports success for code that type-checks and does the wrong thing. This asks once for
 * executed tests; it does not hard-fail, because a compile *is* evidence and some changes have no
 * behaviour to assert.
 */
const TEST_EVIDENCE_NUDGE =
  "That build/typecheck passing shows the code compiles, not that it behaves correctly. Run the smallest relevant existing test or smoke command for the changed behaviour and report the real result. Add a regression test only when the change would otherwise be unprotected. If the change genuinely has no behaviour to assert (documentation, formatting, configuration), say so explicitly and stop.";

const TRANSIENT_PROVIDER_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * Whether another identical provider request is likely to succeed.
 *
 * Explicit HTTP status wins over fuzzy message matching. In particular, auth, validation and 404
 * endpoint mistakes must reach the user immediately instead of being repeated three times. The
 * recursive cause walk handles fetch/SDK wrappers without depending on one provider's error class.
 */
export function isRetryableProviderError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  const messages: string[] = [];
  for (let depth = 0; current !== undefined && current !== null && depth < 5 && !visited.has(current); depth += 1) {
    visited.add(current);
    const record = errorRecord(current);
    if (current instanceof Error) messages.push(current.message);
    else if (typeof current === "string") messages.push(current);
    if (!record) break;

    const status = Number(record.status ?? record.statusCode);
    if (Number.isInteger(status)) {
      if (status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
      if (status >= 400 && status < 600) return false;
    }
    const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
    if (TRANSIENT_PROVIDER_CODES.has(code)) return true;
    current = record.cause;
  }
  return messages.some((message) => /\b(?:timed?\s*out|timeout|rate\s*limit|overload(?:ed)?|temporar(?:y|ily)|connection\s*reset|socket\s*hang\s*up|fetch\s*failed|network\s*error)\b/i.test(message));
}

export function providerFailureKind(error: unknown): ProviderFailureKind {
  let current: unknown = error;
  const visited = new Set<unknown>();
  const messages: string[] = [];
  for (let depth = 0; current !== undefined && current !== null && depth < 5 && !visited.has(current); depth += 1) {
    visited.add(current);
    const record = errorRecord(current);
    if (current instanceof Error) messages.push(current.message);
    else if (typeof current === "string") messages.push(current);
    if (!record) break;
    const status = Number(record.status ?? record.statusCode);
    if (status === 408) return "timeout";
    if (status === 429) return "rate_limit";
    if (status >= 500 && status < 600) return "server";
    const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
    if (/TIMEOUT/.test(code) || code === "ETIMEDOUT") return "timeout";
    if (TRANSIENT_PROVIDER_CODES.has(code)) return "network";
    current = record.cause;
  }
  const message = messages.join(" ");
  if (/rate\s*limit|too many requests/i.test(message)) return "rate_limit";
  if (/timed?\s*out|timeout/i.test(message)) return "timeout";
  if (/overload|service unavailable|bad gateway|gateway timeout/i.test(message)) return "server";
  if (/connection|socket|fetch failed|network/i.test(message)) return "network";
  return "unknown";
}

function providerRetryDelay(attempt: number, signal?: AbortSignal): Promise<boolean> {
  // Deterministic exponential backoff keeps tests and logs reproducible. The abort listener is
  // what makes Ctrl+C immediate while Nova is between attempts instead of waiting for a timer.
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => finish(false);
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(elapsed);
    };
    const timer = setTimeout(() => finish(true), 100 * 2 ** attempt);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
    // Sized for the largest context any current model has (1M tokens, roughly 3M characters), since
    // the caller now derives these from the model rather than passing a constant. The old ceilings
    // were the 200K-model figures themselves, so a session on a 1M model was rejected by its own
    // budget — the validator is here to catch nonsense, not to re-impose a smaller model's limits.
    [request.maxToolResultChars, 128, 1_000_000, "maxToolResultChars"],
    [request.maxTotalToolResultChars, 128, 4_000_000, "maxTotalToolResultChars"],
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

/** Where an oversized tool result was put, as the model and the front end both need to see it. */
export type StoredToolArtifact = {
  /** Root-relative path the model can hand straight to `read_file`. */
  path: string;
  bytes: number;
  lines: number;
  /** True when even the stored copy had to be cut — the store has its own ceiling. */
  elided: boolean;
};

/**
 * Somewhere to put a tool result that is too large to live in the conversation.
 *
 * Injected rather than built in, because *where* an artifact belongs is a property of the backend:
 * a sandboxed session must write it inside the sandbox, next to the files the agent can actually
 * read. The runtime only needs the promise of a path back. A runtime constructed without one keeps
 * the old behaviour exactly — the result is truncated and the rest is gone.
 */
export interface ToolResultArtifactStore {
  put(input: { toolName: string; toolCallId: string; content: string }): Promise<StoredToolArtifact>;
}

/**
 * Below this many characters an excerpt is not worth building: the explanatory header would be
 * most of what the model receives, which is less useful than the plain truncation it replaces.
 */
const EVICTION_MIN_BUDGET = 400;

/** Room set aside for the "N lines elided" marker, which is written after the split is chosen. */
const ELISION_MARKER_BUDGET = 96;

/**
 * Share of the per-call budget an evicted excerpt may use.
 *
 * The excerpt is a sample, not a substitute: its job is to show how the output starts, how it ends,
 * and that there is a file holding the rest. Filling the whole budget with head and tail spent
 * ~36,000 characters proving something 4,000 proves just as well.
 */
const EXCERPT_SHARE = 0.1;

/**
 * Floor for that share, so the excerpt can still do its job.
 *
 * The header alone is ~245 characters and the elision marker another 96. Below roughly this, there
 * is no room left for any actual output and `evictedToolResult` correctly refuses to build an
 * excerpt at all — which would silently drop the artifact path, the one thing the model needs to
 * find the rest.
 */
const EXCERPT_FLOOR = 1_200;

/**
 * Smallest result worth checking for a duplicate.
 *
 * Below this the reference line costs about what the content does, and a transcript full of
 * "identical to an earlier result" notes for two-line outputs is harder to read for no saving.
 */
const DEDUPE_MIN_CHARS = 2_000;

function takeWithinBudget(lines: readonly string[], budget: number, fromEnd: boolean): string[] {
  const taken: string[] = [];
  let used = 0;
  for (let step = 0; step < lines.length; step += 1) {
    const line = lines[fromEnd ? lines.length - 1 - step : step];
    const cost = line.length + 1;
    if (used + cost > budget) break;
    used += cost;
    taken.push(line);
  }
  return fromEnd ? taken.reverse() : taken;
}

/**
 * The bounded thing the model sees in place of a result that has been written to a file.
 *
 * Head *and* tail, not a prefix. A truncated prefix is precisely the wrong half of a test log, a
 * stack trace or a build: the answer is almost always at the end, and cutting from the front is
 * how an agent ends up reporting "the command produced a lot of output" instead of the one line
 * that said what failed. The elision marker between them names the path again, so the way to get
 * the middle is legible at the point where the middle went missing.
 *
 * Guaranteed never longer than `budget`, whatever the content — the caller is spending a context
 * budget, and a helper that can overshoot it is a helper that has to be re-truncated anyway.
 */
export function evictedToolResult(content: string, artifact: StoredToolArtifact, budget: number): string {
  const header =
    `[Output too large for the transcript: ${artifact.lines} lines, ${artifact.bytes} bytes.` +
    ` The whole thing is saved at ${artifact.path} — read any window of it with read_file(path, offset, limit),` +
    ` or search it with run_command. The beginning and end are below.]`;
  if (budget < EVICTION_MIN_BUDGET || header.length + ELISION_MARKER_BUDGET + 64 > budget) return truncate(content, budget);

  const lines = content.split("\n");
  const bodyBudget = budget - header.length - 2 - ELISION_MARKER_BUDGET;
  const headBudget = Math.floor(bodyBudget * 0.6);
  const head = takeWithinBudget(lines, headBudget, false);
  const tail = takeWithinBudget(lines.slice(head.length), bodyBudget - headBudget, true);
  const elided = lines.length - head.length - tail.length;
  const marker = `...[${elided} line${elided === 1 ? "" : "s"} elided — full output at ${artifact.path}]...`;
  const assembled = [header, "", ...head, marker, ...tail].join("\n");
  return assembled.length <= budget ? assembled : assembled.slice(0, budget);
}

export class BoundedAgentRuntime {
  private readonly toolsByName: Map<string, AgentTool>;

  constructor(
    private readonly dependencies: { model: AgentTurnProvider; tools: AgentTool[]; control: AgentRuntimeControl; prices: ModelPriceCatalog; artifacts?: ToolResultArtifactStore },
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
    /** Digest → the call that first carried it, so an identical result is referenced rather than repeated. */
    const sentResults = new Map<string, { toolName: string; path?: string }>();
    let workspaceNeedsVerification = false;
    let verificationNudges = 0;
    let unavailableToolRecoveries = 0;
    let toolTurnRecoveries = 0;
    // Truncated turns resumed so far in this run, capped by `MAX_LENGTH_CONTINUATIONS`.
    let lengthContinuations = 0;
    // Strongest evidence seen for the workspace changes in this run, as a rung on `EVIDENCE_RANK`,
    // and which escalations the model has already been asked for. Each is asked at most once: a
    // model that answers "this change has nothing to assert" must be able to finish.
    let strongestEvidence = 0;
    let askedForTestEvidence = false;
    // Measured once per part, not once per iteration: `messages` only ever grows inside this loop,
    // so a message already measured cannot change. The tool definitions are constant for the run
    // and are folded in first, which is why `measured` starts at zero rather than tracking them.
    const promptTotals = addPart(newPartTotals(), JSON.stringify(definitions));
    let measured = 0;

    const stop = async (status: AgentRuntimeResult["status"], summary: string, iterations: number): Promise<AgentRuntimeResult> => {
      await this.dependencies.control.persistEvent({ type: "runtime_stop", status, summary });
      return { status, summary, messages, usage, actualModelRwf, iterations, toolCallsExecuted };
    };

    for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
      await this.dependencies.control.heartbeat();
      if (request.signal?.aborted || await this.dependencies.control.isCancellationRequested()) return stop("cancelled", "Run cancelled at a safe checkpoint.", iteration - 1);

      const approvedRemaining = request.modelReservationRwf - actualModelRwf;
      for (; measured < messages.length; measured += 1) {
        for (const part of agentMessagePromptParts(messages[measured])) addPart(promptTotals, part);
      }
      const maximumOutputTokens = affordableOutputTokensFor(
        tokenEstimateFrom(promptTotals),
        request.maxOutputTokens,
        Math.max(0, approvedRemaining),
        this.dependencies.prices,
      );
      if (maximumOutputTokens < 1) return stop("iteration_limit", "Run reached its approved model budget before another provider call.", iteration - 1);

      const modelRequest: AgentModelRequest = {
        ...(request.effort ? { effort: request.effort } : {}),
        messages: [...messages],
        tools: definitions,
        maxOutputTokens: maximumOutputTokens,
        safetyIdentifier: request.safetyIdentifier,
        signal: request.signal,
        // Deltas are fire-and-forget: a slow consumer must never stall generation, and a lost
        // delta costs nothing because the completed turn is still the source of truth.
        onTextDelta: (text) => void this.dependencies.control.persistEvent({ type: "assistant_delta", iteration, text }),
      };
      let turn: AgentModelTurn | undefined;
      for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
        let emittedOutput = false;
        const attemptRequest: AgentModelRequest = {
          ...modelRequest,
          onTextDelta: modelRequest.onTextDelta
            ? (text) => { emittedOutput = true; modelRequest.onTextDelta!(text); }
            : undefined,
        };
        try {
          turn = await this.dependencies.model.complete(attemptRequest);
          break;
        } catch (error) {
          if (request.signal?.aborted || await this.dependencies.control.isCancellationRequested()) {
            return stop("cancelled", "Run cancelled while waiting for the model provider.", iteration - 1);
          }
          // Retrying after streamed output risks duplicating both billed text and tool intent. A
          // retry is safe only while the failed attempt has remained completely invisible.
          if (emittedOutput) throw new ProviderRequestError(error, { attempts: attempt + 1, retrySuppressed: "output_started" });
          if (!isRetryableProviderError(error)) throw error;
          if (attempt >= MAX_PROVIDER_RETRIES) throw new ProviderRequestError(error, { attempts: attempt + 1 });
          const delayMs = 100 * 2 ** attempt;
          await this.dependencies.control.persistEvent({
            type: "provider_retry",
            iteration,
            nextAttempt: attempt + 2,
            maxAttempts: MAX_PROVIDER_RETRIES + 1,
            delayMs,
            reason: providerFailureKind(error),
          });
          if (!await providerRetryDelay(attempt, request.signal)) {
            return stop("cancelled", "Run cancelled while waiting to retry the model provider.", iteration - 1);
          }
          if (request.signal?.aborted || await this.dependencies.control.isCancellationRequested()) {
            return stop("cancelled", "Run cancelled while waiting to retry the model provider.", iteration - 1);
          }
        }
      }
      // The loop either returned a turn or rethrew the final provider error.
      if (!turn) throw new Error("Model provider retry loop ended without a response");
      usage = addUsage(usage, turn.usage);
      actualModelRwf = priceActualModelUsage(usage.inputTokens, usage.outputTokens, this.dependencies.prices);
      if (actualModelRwf > request.modelReservationRwf) throw new Error("Actual model usage exceeds the reserved model budget");
      await this.dependencies.control.persistEvent({ type: "model_turn", iteration, responseId: turn.responseId, model: turn.model, toolCallCount: turn.toolCalls.length, usage: turn.usage });

      if (turn.finishReason === "refusal") return stop("blocked", turn.refusal?.trim() || "Model refused the task.", iteration);
      if (turn.finishReason === "length") {
        // Not a failure: the provider answered, the tokens were spent, and the text that arrived is
        // as real as any other. What is missing is the rest of it — so the partial answer is kept in
        // the transcript and the model is asked to carry on, rather than the turn being thrown away
        // along with everything it already paid for.
        const partial = turn.content.trim();
        if (lengthContinuations >= MAX_LENGTH_CONTINUATIONS) {
          return stop("iteration_limit", `Model kept exceeding its output limit: ${MAX_LENGTH_CONTINUATIONS} continuations were not enough to finish the answer.`, iteration);
        }
        lengthContinuations += 1;
        messages.push({ role: "assistant", content: partial || "(no output before the limit was reached)" });
        messages.push({ role: "user", content: LENGTH_CONTINUATION_NUDGE });
        continue;
      }
      if (turn.finishReason === "stop") {
        const summary = turn.content.trim() || "Model completed without a summary.";
        messages.push({ role: "assistant", content: summary });
        if (workspaceNeedsVerification && verificationNudges < MAX_VERIFICATION_NUDGES) {
          // Drive the loop back to the model instead of handing the gap to the human: the agent
          // still has budget and the tools to close it itself, so make it, rather than merely
          // reporting that it didn't. The nudge cap keeps this bounded by the same iteration and
          // tool-call budgets as everything else — a model that never verifies still terminates.
          verificationNudges += 1;
          messages.push({ role: "user", content: VERIFICATION_NUDGE, internal: true });
          continue;
        }
        // One rung at a time up `EVIDENCE_RANK`, each asked at most once. Compile-only evidence is
        // accepted in the end, but not before asking for executed tests; unit tests are accepted in
        // the end, but not before asking for one exercise of the assembled program. Both stop at
        // asking, because both answers ("nothing to assert", "nothing to assemble") are sometimes
        // the truth, and a gate that cannot be satisfied honestly is a gate that gets worked around.
        if (strongestEvidence === EVIDENCE_RANK.check && !askedForTestEvidence) {
          askedForTestEvidence = true;
          messages.push({ role: "user", content: TEST_EVIDENCE_NUDGE, internal: true });
          continue;
        }
        return workspaceNeedsVerification
          // The gate must lead — this is not a success, and a reader skimming the ledger has to see
          // that first. But replacing the summary outright threw away the only account of what the
          // run actually did, which is the thing a person needs in order to decide what to do next.
          ? stop("needs_verification", `Workspace changes were made without passing verification evidence. The agent reported: ${summary}`, iteration)
          : stop("completed", summary, iteration);
      }
      const recoverToolTurn = (reason: string, instruction: string): boolean => {
        if (toolTurnRecoveries >= MAX_TOOL_TURN_RECOVERIES) return false;
        toolTurnRecoveries += 1;
        messages.push({ role: "user", content: `${reason} ${instruction}`, internal: true });
        return true;
      };
      if (turn.finishReason !== "tool_calls" || turn.toolCalls.length === 0) {
        if (recoverToolTurn("Your previous response declared tool use but contained no usable tool calls.", "Try again with a valid tool call, or answer normally if no tool is needed.")) continue;
        return stop("failed", "Model repeatedly returned an invalid tool-call turn.", iteration);
      }
      if (turn.toolCalls.length > request.maxToolCallsPerTurn) {
        if (recoverToolTurn(
          `Your previous response requested ${turn.toolCalls.length} tools, above the per-turn limit of ${request.maxToolCallsPerTurn}; none were executed.`,
          `Retry with at most ${request.maxToolCallsPerTurn} calls, prioritizing the calls needed to make progress.`,
        )) continue;
        return stop("failed", `Model repeatedly exceeded the per-turn tool-call limit of ${request.maxToolCallsPerTurn}.`, iteration);
      }
      if (toolCallsExecuted + turn.toolCalls.length > request.maxToolCalls) return stop("iteration_limit", "Run reached its tool-call budget.", iteration);

      const seenCallIds = new Set<string>();
      const malformed = turn.toolCalls.find((call) => {
        if (!call.id.trim() || seenCallIds.has(call.id)) return true;
        seenCallIds.add(call.id);
        return !normalizeArguments(call.arguments);
      });
      if (malformed) {
        if (recoverToolTurn(
          "Your previous tool-call response was malformed; no tools were executed.",
          "Retry with a unique non-empty id for every call and a JSON object for every arguments value.",
        )) continue;
        return stop("failed", "Model repeatedly returned malformed tool calls.", iteration);
      }

      const unavailable = turn.toolCalls.find((call) => {
        const tool = this.toolsByName.get(call.name);
        return !tool || !capabilities.has(tool.capabilityId);
      });
      if (unavailable) {
        if (unavailableToolRecoveries >= MAX_UNAVAILABLE_TOOL_RECOVERIES) {
          return stop("failed", `Tool ${unavailable.name} is outside the run capability scope.`, iteration);
        }
        unavailableToolRecoveries += 1;
        messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            internal: true,
            content: call.id === unavailable.id
              ? `Tool ${call.name} is unavailable in the current mode. Continue with the listed tools, or answer without it.`
              : "This batch was not executed because another call was unavailable. Retry any still-needed available call separately.",
          });
        }
        continue;
      }

      const prepared: Array<{ call: AgentToolCall; tool: AgentTool; argumentsValue: Record<string, unknown> }> = [];
      for (const call of turn.toolCalls) {
        const tool = this.toolsByName.get(call.name)!;
        const argumentsValue = normalizeArguments(call.arguments)!;
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
        if (request.signal?.aborted || await this.dependencies.control.isCancellationRequested()) return { call, tool, result: { content: "Tool execution cancelled before start.", isError: true } as AgentToolResult };
        // Announced before the work, not after: a read of a large file or a long-running command
        // is exactly the moment a person needs to know what is being waited on.
        await this.dependencies.control.persistEvent({ type: "tool_call", toolCallId: call.id, toolName: call.name, effect: tool.effect, arguments: argumentsValue });
        try {
          return { call, tool, result: await tool.execute(argumentsValue, request) };
        } catch (error) {
          return { call, tool, result: { content: error instanceof Error ? error.message : "Tool execution failed", isError: true } as AgentToolResult };
        }
      };
      /**
       * Runs the batch as consecutive groups rather than all-or-nothing.
       *
       * The rule used to be that *every* call had to be parallel-safe or the whole batch went
       * serial, which made parallelism an all-or-nothing property of the slowest member: a turn of
       * five file reads and one write executed the five reads one after another, for no reason
       * other than the write's presence. Grouping by consecutive runs keeps the concurrency where
       * it is safe and loses none of the ordering that makes it safe.
       *
       * Order is the whole correctness argument, so it is preserved exactly. A parallel-safe run is
       * only ever formed from calls the model emitted *adjacently*, and an effectful call always
       * executes alone and in its emitted position. That means nothing is ever reordered across a
       * write: a read before a write still observes the pre-write state and a read after it still
       * observes the post-write state, which is precisely what a caller that sequenced them
       * deliberately is entitled to assume. Reordering independent reads *among themselves* is the
       * only freedom taken, and they cannot observe each other.
       *
       * The gain is small locally — a file read is sub-millisecond — and large on a remote
       * backend, where every call is a network round trip to an E2B or Docker sandbox.
       */
      const groups: (typeof prepared)[] = [];
      for (const item of prepared) {
        const concurrent = item.tool.parallelSafe && item.tool.effect === "none";
        const last = groups.at(-1);
        const lastIsConcurrent = last !== undefined && last[0].tool.parallelSafe && last[0].tool.effect === "none";
        if (concurrent && lastIsConcurrent) last.push(item);
        else groups.push([item]);
      }
      const results: Array<{ call: AgentToolCall; tool: AgentTool; result: AgentToolResult }> = [];
      for (const group of groups) {
        if (group.length === 1) results.push(await runOne(group[0]));
        else results.push(...await Promise.all(group.map(runOne)));
      }

      /**
       * What one iteration may add to the transcript, however many calls it made.
       *
       * Eight parallel calls at the per-call budget is 320,000 characters — around 107,000 tokens
       * appended in a single step, which on a 200K-context model is the context error itself
       * rather than a step towards one. The per-call and total budgets both allowed it: one is
       * too small a unit to notice, the other too large. A quarter of the total allowance per
       * iteration keeps a single big result whole while bounding the pile-up.
       */
      const iterationCharBudget = Math.max(request.maxToolResultChars, Math.floor(request.maxTotalToolResultChars / 4));
      let iterationChars = 0;

      for (const { call, tool, result } of results) {
        toolCallsExecuted += 1;
        const remaining = request.maxTotalToolResultChars - totalToolResultChars;
        const budget = Math.max(0, Math.min(request.maxToolResultChars, remaining, iterationCharBudget - iterationChars));
        const raw = result.content || "(empty tool result)";
        /**
         * Oversized results leave the conversation and become files.
         *
         * Only the excerpt is charged against the context budget, which is the entire point: a
         * 400,000-character test log costs the transcript a few hundred characters and stays
         * fully readable through `read_file`, instead of costing the whole per-call budget and
         * still being missing the part that mattered.
         *
         * Storing is best-effort by construction. A read-only sandbox or a full disk must not
         * turn into a failed turn over bookkeeping, so a store that throws falls back to exactly
         * the truncation that would have happened if no store had been configured at all.
         */
        let artifact: StoredToolArtifact | undefined;
        let content = truncate(raw, budget);
        /**
         * Eviction has to *save* tokens, and just over the line it does the opposite.
         *
         * Measured: at a 40,000-character budget, a 41,000-character result evicts to a 39,864
         * character excerpt — 1,136 characters saved — and the header it carries tells the model to
         * go and read the file. One `read_file` follow-up costs up to another 40,000, so the
         * "saving" is 35x more expensive than having sent the 41,000 characters once. The loss band
         * runs from `budget` to `2 x budget`, and break-even is exactly at the top of it.
         *
         * So the transcript takes the whole result when it is within twice the budget and the total
         * allowance can still afford it, and evicts only above that, where eviction pays for itself
         * many times over: a 400,000-character log becomes an excerpt and a path.
         */
        const withinTwiceBudget = raw.length <= budget * 2 && raw.length <= remaining;
        /**
         * A result identical to one already in this transcript is sent once.
         *
         * Reading the same file twice, or re-running the same failing test, used to append a second
         * full copy — nothing deduplicated anything, and the model pays for every character of both.
         * A digest it already has is a pointer, not a payload. Only worth doing for results big
         * enough that the pointer is smaller than the thing: below that the reference is the cost.
         */
        const digest = raw.length >= DEDUPE_MIN_CHARS ? createHash("sha256").update(raw).digest("hex") : undefined;
        const alreadySent = digest ? sentResults.get(digest) : undefined;
        if (alreadySent) {
          content = `[Identical to the earlier ${alreadySent.toolName} result in this conversation${alreadySent.path ? `, saved at ${alreadySent.path}` : ""}. Unchanged since then; re-read it there if you need it again.]`;
        } else if (withinTwiceBudget) {
          content = raw;
        } else if (this.dependencies.artifacts && raw.length > budget && budget > 0) {
          const stored = await this.dependencies.artifacts
            .put({ toolName: call.name, toolCallId: call.id, content: raw })
            .catch(() => undefined);
          if (stored) {
            artifact = stored;
            // A tenth of the budget, not the whole of it. The excerpt exists to show the shape of
            // the output and its ending; the file holds the rest, and 4,000 characters of head and
            // tail say what 40,000 said. Measured: this is ~36,000 characters saved on every large
            // result, with the same path to the full text.
            content = evictedToolResult(raw, stored, Math.min(budget, Math.max(EXCERPT_FLOOR, Math.round(budget * EXCERPT_SHARE))));
          }
        }
        if (digest && !alreadySent) sentResults.set(digest, { toolName: call.name, path: artifact?.path });
        totalToolResultChars += content.length;
        iterationChars += content.length;
        messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
        const effect = tool.effect === "external" ? "external" : result.effect ?? tool.effect;
        if (!result.isError && effect === "workspace") workspaceNeedsVerification = true;
        if (!result.isError && result.verification?.passed) {
          workspaceNeedsVerification = false;
          // Unclassified evidence reads as `check`: the weaker claim is the safe one to infer.
          // Kept as a maximum so a later weak check cannot demote what a stronger run established —
          // running the linter after the e2e suite is not a reason to ask for the e2e suite again.
          strongestEvidence = Math.max(strongestEvidence, EVIDENCE_RANK[result.verification.kind ?? "check"]);
        }
        await this.dependencies.control.persistEvent({ type: "tool_result", toolCallId: call.id, toolName: call.name, isError: result.isError ?? false, effect, content, ...(result.data ? { data: result.data } : {}), ...(artifact ? { artifact } : {}) });
      }
      if (totalToolResultChars >= request.maxTotalToolResultChars) return stop("iteration_limit", "Run reached its total tool-result context budget.", iteration);
    }
    return stop("iteration_limit", "Run reached its model iteration budget.", request.maxIterations);
  }
}
