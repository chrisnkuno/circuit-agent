import { BoundedAgentRuntime, type AgentTool } from "../agent-runtime";
import { capabilitiesFor, CONSERVATIVE_CAPABILITIES } from "../providers/model-capabilities";
import { PROVIDER_INFO } from "../providers/provider-specs";
import { ExaSearchClient } from "../providers/exa";
import { LocalWorkspace } from "./backends";
import { capabilitiesForMode } from "./permissions";
import { buildNovaSystemPrompt, collectProjectContext } from "./prompt";
import { compactionUrgency } from "./session";
import { createNovaTools, TodoList } from "./tools";
import { predictAgentUsage } from "./cost";

/**
 * What "optimized" means here, written down so it can be checked.
 *
 * Every number in this file was measured, and every one of them will rot. A prompt section gets
 * added, a model ships with a bigger window, a tool schema grows a field — and the system quietly
 * returns to spending what it used to spend, because nothing was watching. The audit that produced
 * these figures took an afternoon and cannot be repeated on every commit by a person.
 *
 * So the map is executable. Each target names one property of the system, the unit it is measured
 * in, the budget it must stay inside, and — the part that makes this more than a dashboard — what
 * to do when it does not. `runOptimizationProbes` measures them all against the live code, so the
 * same registry serves three readers:
 *
 * - a test, which fails the build when a target regresses (`optimization-map.test.ts`);
 * - a person, through the report script, who wants to know where the system stands today;
 * - Nova itself, which can read the failing targets and their remediation and act on them.
 *
 * That last one is the point of the shape. A finding phrased as prose in a document is something a
 * human has to translate into work. A finding phrased as `{ measured, budget, remediation }` is
 * something an agent can pick up, verify it reproduced, fix, and re-measure — which is what
 * self-improvement has to mean if it is to mean anything.
 *
 * Two rules for adding a target:
 *
 * **Measure the behaviour, not the constant.** A probe that reads back the constant it is
 * guarding proves only that the constant is still there. The eviction probe below runs a real
 * result through the real runtime; that is why it would have caught the loss band that a
 * threshold assertion could not.
 *
 * **Bound both sides.** A budget with only a ceiling passes when the measurement collapses to
 * zero, which is usually a worse bug than the one being guarded — the eviction probe below read
 * `<= 1.05` and stayed green while the regression it exists to catch was deliberately reintroduced,
 * because eviction makes that ratio *smaller*. Every new target should be tested by breaking the
 * code it guards and watching it go red.
 *
 * **An honest gap beats a fake number.** A target with no `measure` reports `unmeasured` and says
 * so everywhere. Inventing a plausible figure is how a map stops being trustworthy, and an
 * untrustworthy map is worse than none because it is still consulted.
 */

export type OptimizationLayer = "prompt" | "context" | "transcript" | "provider" | "runtime" | "state" | "cli";

export type OptimizationTarget = {
  id: string;
  layer: OptimizationLayer;
  /** One line: the property being held, in plain words. */
  what: string;
  /** The unit `measure` returns, so a number is never read as the wrong thing. */
  metric: string;
  /** The guardrail. At least one bound; a measurement outside it is a regression. */
  budget: { max?: number; min?: number };
  /** What the measurement was when this target was written, for the record. */
  baseline?: { value: number; on: string };
  /** Where the behaviour lives, so a failure has somewhere to go. */
  evidence: string;
  /** What to do when the budget is broken. Written for whoever — or whatever — reads it next. */
  remediation: string;
  /** Absent means not yet automatable; the target still appears, reported as unmeasured. */
  measure?: (context: ProbeContext) => Promise<number>;
};

export type ProbeContext = {
  /** A real project to measure against. The repository root when a probe needs one. */
  root: string;
};

export type ProbeResult = {
  target: OptimizationTarget;
  status: "pass" | "fail" | "unmeasured" | "error";
  measured?: number;
  detail?: string;
};

/** Rough tokens for a length of prose, at this repository's measured 2.98 characters per token. */
const CHARS_PER_TOKEN = 2.98;

function tokensOf(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/** The fixed cost of one request in a given mode: system prompt plus every tool schema. */
async function fixedRequestTokens(root: string, mode: "build" | "plan" | "defender"): Promise<number> {
  const context = await collectProjectContext(root);
  const tools = await createNovaTools({
    workspace: new LocalWorkspace(root),
    todos: new TodoList(),
    // A real turn always wires delegation before it scopes the tool list. Omitting it here made
    // the fixed-cost report look roughly 200 tokens cheaper than the request Nova actually sends.
    delegate: async () => ({ report: "", status: "completed", iterations: 0, toolCallsExecuted: 0 }),
  });
  const allowed = capabilitiesForMode(mode);
  const scoped = tools.filter((tool) => allowed.includes(tool.capabilityId));
  const schemas = JSON.stringify(scoped.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
  const prompt = buildNovaSystemPrompt(context, mode, scoped.map((tool) => tool.name));
  return tokensOf(prompt) + tokensOf(schemas);
}

/**
 * Share of a model's window that fills before compaction becomes unavoidable.
 *
 * Binary search over transcript size rather than a linear walk: the probe runs on every test run,
 * and stepping 20,000 characters at a time up to a million-token window built and measured
 * hundreds of multi-megabyte strings to answer one question. A slow probe is a probe someone
 * eventually skips.
 */
function compactionHeadroom(contextLimit: number, outputBudget: number): number {
  const line = "export function handler(request: Request): Response { return new Response(\"ok\"); }\n";
  const required = (chars: number): boolean => {
    const body = line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
    return compactionUrgency([{ role: "user", content: body }], { contextLimit, outputBudget }) === "required";
  };

  // Double until it trips, so the search starts from a bracket that is known to contain the answer.
  let high = Math.max(20_000, Math.round(contextLimit / 10));
  const ceiling = contextLimit * 20;
  while (!required(high)) {
    if (high >= ceiling) return 1;
    high = Math.min(high * 2, ceiling);
  }
  let low = high / 2;
  // Ten halvings put the boundary inside 0.1% of the bracket, which is far finer than the budget
  // it is compared against.
  for (let step = 0; step < 10; step += 1) {
    const middle = Math.round((low + high) / 2);
    if (required(middle)) high = middle;
    else low = middle;
  }
  const body = line.repeat(Math.ceil(high / line.length)).slice(0, high);
  return tokensOf(body) / contextLimit;
}

/** A read-only tool that returns exactly the content it was built with. */
function echoTool(content: string): AgentTool {
  return {
    name: "echo",
    description: "Returns fixed content",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capabilityId: "workspace.files.read",
    effect: "none",
    requiresApproval: false,
    parallelSafe: true,
    async execute() { return { content }; },
  };
}

/**
 * How much of a result of a given size actually reaches the transcript.
 *
 * Runs the real runtime with a real artifact store, because the property under test is a
 * behaviour, not a threshold: the loss band this guards against was invisible to every assertion
 * that read the constants instead of running a result through them.
 */
async function transcriptCostFor(rawChars: number, budget: number): Promise<number> {
  const content = "x".repeat(rawChars);
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const turns = [
    { responseId: "r1", model: "probe", finishReason: "tool_calls" as const, content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage },
    { responseId: "r2", model: "probe", finishReason: "stop" as const, content: "done", toolCalls: [], usage },
  ];
  let call = 0;
  const runtime = new BoundedAgentRuntime({
    model: { async complete() { return turns[Math.min(call++, turns.length - 1)]; } },
    tools: [echoTool(content)],
    prices: { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
    artifacts: {
      async put(input) {
        return { path: ".nova/artifacts/echo-probe.txt", bytes: input.content.length, lines: 1, elided: false };
      },
    },
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return true; },
      async persistEvent() {},
    },
  });
  const result = await runtime.execute({
    taskId: "probe", runId: "probe", stepId: "probe",
    objective: "probe", systemPrompt: "probe",
    allowedCapabilityIds: ["workspace.files.read"],
    maxIterations: 4, maxToolCalls: 4, maxToolCallsPerTurn: 4,
    maxToolResultChars: budget, maxTotalToolResultChars: budget * 10,
    maxOutputTokens: 1_000, modelReservationRwf: 1_000_000, safetyIdentifier: "probe",
  });
  return result.messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * What one iteration of several parallel calls actually appends.
 *
 * Separate from `transcriptCostFor` because the property is about the *pile-up*: the per-call and
 * total budgets each looked reasonable while eight calls between them could append a whole context
 * window in a single step.
 */
async function parallelIterationCost(calls: number, rawChars: number, budget: number): Promise<number> {
  const content = "x".repeat(rawChars);
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const names = Array.from({ length: calls }, (_, index) => `echo_${index}`);
  const turns = [
    {
      responseId: "r1", model: "probe", finishReason: "tool_calls" as const, content: "",
      toolCalls: names.map((name, index) => ({ id: `c${index}`, name, arguments: {} })), usage,
    },
    { responseId: "r2", model: "probe", finishReason: "stop" as const, content: "done", toolCalls: [], usage },
  ];
  let call = 0;
  const runtime = new BoundedAgentRuntime({
    model: { async complete() { return turns[Math.min(call++, turns.length - 1)]; } },
    tools: names.map((name) => ({ ...echoTool(content), name })),
    prices: { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return true; },
      async persistEvent() {},
    },
  });
  const result = await runtime.execute({
    taskId: "probe", runId: "probe", stepId: "probe",
    objective: "probe", systemPrompt: "probe",
    allowedCapabilityIds: ["workspace.files.read"],
    maxIterations: 4, maxToolCalls: calls + 2, maxToolCallsPerTurn: calls,
    maxToolResultChars: budget, maxTotalToolResultChars: budget * 10,
    maxOutputTokens: 1_000, modelReservationRwf: 1_000_000, safetyIdentifier: "probe",
  });
  return result.messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * How many model calls a run spends when its evidence climbs the ladder one rung at a time.
 *
 * The scenario is exact, and it took three attempts to get right — the first two measured the same
 * number whichever way the code behaved, which is the definition of a decorative probe. The rungs
 * only cost a round trip when the run actually *climbs*: a typecheck, then a nudge, then real tests,
 * then either one more question or none. Asking for the test and behaviour rungs together is what
 * removes that last question, and this is where the difference shows up.
 */
async function nudgeRoundTrips(): Promise<number> {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  let evidenceCalls = 0;
  const verifier: AgentTool = {
    name: "run_command",
    description: "Runs a command",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capabilityId: "workspace.terminal",
    effect: "workspace",
    requiresApproval: false,
    parallelSafe: false,
    async execute() {
      // A typecheck first, then real tests: the run gets better, which is what makes the ladder
      // escalate at all.
      evidenceCalls += 1;
      const kind = evidenceCalls === 1 ? ("check" as const) : ("tests" as const);
      return { content: "exit 0", verification: { passed: true, kind, scope: "targeted" as const, summary: `${kind} exited 0` } };
    },
  };
  let calls = 0;
  const runtime = new BoundedAgentRuntime({
    model: {
      async complete() {
        calls += 1;
        // Verify on the first call, and again on the call that answers the first nudge; otherwise
        // report done. Those two positions are what make the run climb a rung.
        if (calls === 1 || calls === 3) {
          return { responseId: "r", model: "probe", finishReason: "tool_calls" as const, content: "", toolCalls: [{ id: `c${calls}`, name: "run_command", arguments: {} }], usage };
        }
        return { responseId: "r", model: "probe", finishReason: "stop" as const, content: "Done.", toolCalls: [], usage };
      },
    },
    tools: [verifier],
    prices: { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return true; },
      async persistEvent() {},
    },
  });
  await runtime.execute({
    taskId: "probe", runId: "probe", stepId: "probe",
    objective: "change something", systemPrompt: "probe",
    allowedCapabilityIds: ["workspace.terminal"],
    maxIterations: 12, maxToolCalls: 6, maxToolCallsPerTurn: 2,
    maxToolResultChars: 4_000, maxTotalToolResultChars: 40_000,
    maxOutputTokens: 1_000, modelReservationRwf: 1_000_000, safetyIdentifier: "probe",
  });
  return calls;
}

export const OPTIMIZATION_TARGETS: readonly OptimizationTarget[] = [
  {
    id: "prompt.fixed-cost.build",
    layer: "prompt",
    what: "What one build-mode request costs before the user has said anything",
    metric: "tokens",
    budget: { min: 2_000, max: 6_000 },
    baseline: { value: 4_546, on: "2026-08-22" },
    evidence: "nova-cli/prompt.ts, nova-cli/tools.ts",
    remediation:
      "A section grew or a tool schema did. Measure per section (the audit method: import the module and print sizes), and move anything the model needs only sometimes behind a tool it can call, the way the defender playbooks moved behind read_playbook.",
    measure: async ({ root }) => fixedRequestTokens(root, "build"),
  },
  {
    id: "prompt.fixed-cost.defender",
    layer: "prompt",
    what: "The same, in defender mode, where the playbooks used to live in the prompt",
    metric: "tokens",
    budget: { min: 4_000, max: 9_000 },
    baseline: { value: 6_041, on: "2026-08-23" },
    evidence: "nova-cli/defender-playbooks.ts, read_playbook in nova-cli/tools.ts",
    remediation:
      "Something put playbook bodies back into the system prompt. Keep the index there and the bodies behind read_playbook; the full set is ~14,300 tokens on every request of every iteration.",
    measure: async ({ root }) => fixedRequestTokens(root, "defender"),
  },
  {
    id: "prompt.prefix-stability",
    layer: "prompt",
    what: "Volatile-looking values in the cached prefix — dates, times, ids that change per turn",
    metric: "occurrences",
    budget: { max: 0 },
    baseline: { value: 0, on: "2026-08-22" },
    evidence: "nova-cli/prompt.ts, providers/anthropic-agent.ts withCacheBreakpoints",
    remediation:
      "Prompt caching is a strict prefix match: one changed byte in the system block invalidates the cache for the whole transcript beneath it, turning a 0.1x read into a 1.25x write every turn. Move whatever varies into the user message for that turn.",
    measure: async ({ root }) => {
      const context = await collectProjectContext(root);
      const prompt = buildNovaSystemPrompt(context, "build", ["read_file"]);
      // ISO timestamps, clock times, and epoch-shaped numbers are the three shapes that show up
      // when something interpolates "now" into a prompt.
      const volatile = prompt.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z|\b\d{2}:\d{2}:\d{2}\b|\b1[6-9]\d{11}\b/g);
      return volatile?.length ?? 0;
    },
  },
  {
    id: "context.compaction-headroom.200k",
    layer: "context",
    what: "How much of a 200K window fills before compaction is unavoidable",
    metric: "share of window",
    // Upper bound too: a transcript that never compacts does not save a call, it hits the
    // provider's hard context error mid-task and loses the turn.
    budget: { min: 0.5, max: 0.95 },
    baseline: { value: 0.615, on: "2026-08-22" },
    evidence: "nova-cli/session.ts estimateMessageTokens / compactionUrgency",
    remediation:
      "The estimator drifted pessimistic again. Compaction costs a model call and a lossy summary and rebuilds the whole prompt cache; firing it at a quarter of the window (the byte-dominated `maximumInputTokens` reading) is the expensive mistake this guards.",
    measure: async () => compactionHeadroom(200_000, 16_000),
  },
  {
    id: "context.compaction-headroom.1m",
    layer: "context",
    what: "The same on a 1M-context model",
    metric: "share of window",
    budget: { min: 0.7, max: 0.95 },
    baseline: { value: 0.846, on: "2026-08-22" },
    evidence: "nova-cli/session.ts, providers/model-capabilities.ts",
    remediation:
      "Either the estimator regressed or the session stopped deriving its context limit from the model. Check `NovaAgent`'s constructor still merges provider capabilities ahead of the defaults.",
    measure: async () => compactionHeadroom(1_000_000, 64_000),
  },
  {
    id: "context.compaction-retention",
    layer: "context",
    what: "How much of the window a compaction keeps verbatim when the recent messages are huge",
    metric: "share of usable window",
    budget: { min: 0.01, max: 0.3 },
    baseline: { value: 0.163, on: "2026-08-22" },
    evidence: "nova-cli/session.ts recentToKeep, planCompaction",
    remediation:
      "The kept tail is sized in tokens, not counted in messages. 'Keep the last six' treated a two-line acknowledgement and a 40,000-character test log as the same size — six of the latter carried ~60,000 tokens past the compaction that happened because the transcript was too large. A number near zero is the opposite failure: a tail the agent cannot continue from.",
    measure: async () => {
      const { planCompaction, estimateMessageTokens } = await import("./session");
      const contextLimit = 200_000;
      const outputBudget = 16_000;
      const messages: Parameters<typeof planCompaction>[0][number][] = [
        { role: "system", content: "You are Nova." },
        { role: "user", content: "Fix the build." },
      ];
      for (let index = 0; index < 40; index += 1) {
        messages.push({ role: "assistant", content: "x".repeat(20_000) });
        messages.push({ role: "user", content: "keep going" });
      }
      for (let index = 0; index < 8; index += 1) messages.push({ role: "assistant", content: "y".repeat(60_000) });
      const plan = planCompaction(messages, { contextLimit, outputBudget });
      if (!plan) throw new Error("the probe's transcript no longer triggers compaction at all");
      return estimateMessageTokens(plan.toKeep) / (contextLimit - outputBudget);
    },
  },
  {
    id: "context.structured-arguments-accounted",
    layer: "context",
    what: "Structured tool-call arguments count toward the transcript before another model call is admitted",
    metric: "share of argument tokens estimated",
    budget: { min: 0.95, max: 1.15 },
    baseline: { value: 1, on: "2026-08-23" },
    evidence: "agent-runtime.ts agentMessagePromptParts, nova-cli/session.ts estimateMessageTokens",
    remediation:
      "Restore tool call ids, names and JSON arguments to the shared prompt-parts accounting path used by both preflight and runtime affordability checks. Counting assistant content alone makes a large write_file call look empty and can admit a request that exceeds either the context or money budget.",
    measure: async () => {
      const { estimateMessageTokens } = await import("./session");
      const argument = "x".repeat(40_000);
      const withoutArguments = estimateMessageTokens([{
        role: "assistant", content: "", toolCalls: [],
      }]);
      const withArguments = estimateMessageTokens([{
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_probe", name: "write_file", arguments: { path: "large.txt", content: argument } }],
      }]);
      // Compare through one estimator. The prose heuristic used by the prompt-size report has a
      // different character ratio, and mixing the two would measure that policy difference rather
      // than whether structured arguments vanished from accounting.
      const emptyUser = estimateMessageTokens([{ role: "user", content: "" }]);
      const argumentAsText = estimateMessageTokens([{ role: "user", content: argument }]) - emptyUser;
      return (withArguments - withoutArguments) / argumentAsText;
    },
  },
  {
    id: "transcript.no-eviction-loss-band",
    layer: "transcript",
    what: "A result just over the per-call budget reaches the model whole, instead of being evicted for a saving that costs more than it saves",
    metric: "ratio of transcript cost to raw size",
    // Bounded on BOTH sides, and the lower bound is the one that matters. Eviction makes this ratio
    // *smaller*, not larger, so a max-only budget passed happily while the regression it was
    // written to catch was reintroduced — caught by deliberately breaking the code and watching the
    // probe stay green. A probe that cannot fail is decoration.
    budget: { min: 0.95, max: 1.05 },
    baseline: { value: 1, on: "2026-08-22" },
    evidence: "agent-runtime.ts, the withinTwiceBudget branch",
    remediation:
      "Eviction returned to firing between 1x and 2x the budget. Measured at a 40,000-char budget, a 41,000-char result saved 1,136 characters and then invited a read_file worth up to 40,000 — 35x worse than sending it once.",
    measure: async () => {
      const budget = 10_000;
      const raw = Math.round(budget * 1.4);
      return await transcriptCostFor(raw, budget) / raw;
    },
  },
  {
    id: "transcript.large-result-excerpt",
    layer: "transcript",
    what: "What a genuinely huge result costs the transcript, given the whole thing is saved to a file anyway",
    metric: "share of the per-call budget",
    // A floor as well: an excerpt small enough to hold neither head nor tail has stopped being a
    // sample of the output and become a footnote saying one existed.
    budget: { min: 0.01, max: 0.35 },
    baseline: { value: 0.12, on: "2026-08-22" },
    evidence: "agent-runtime.ts EXCERPT_SHARE, evictedToolResult",
    remediation:
      "The excerpt is filling the budget again. Head and tail exist to show shape and ending; the artifact holds the rest, and 4,000 characters say what 40,000 said.",
    measure: async () => {
      const budget = 10_000;
      return await transcriptCostFor(budget * 40, budget) / budget;
    },
  },
  {
    id: "transcript.deep-research-synthesis-overhead",
    layer: "transcript",
    what: "How much of deep research's raw source text is repeated beneath a successful synthesis",
    metric: "share of raw extract characters",
    budget: { min: 0.01, max: 0.1 },
    baseline: { value: 0.028, on: "2026-08-23" },
    evidence: "nova-cli/tools.ts deep_research successful-synthesis response",
    remediation:
      "Return the synthesized answer and deduplicated source URLs when synthesis succeeds. Raw extracts have already informed that answer; appending them again can add tens of thousands of characters to every later model request. Keep compact hits only as the fallback when synthesis is empty.",
    measure: async ({ root }) => {
      const rawPerResult = 4_000;
      const results = Array.from({ length: 6 }, (_, index) => ({
        title: `Source ${index + 1}`,
        url: `https://example.test/${index + 1}`,
        publishedDate: null,
        author: null,
        highlights: [],
        text: "x".repeat(rawPerResult),
      }));
      const search = new ExaSearchClient({
        apiKey: "optimization-probe",
        fetchImpl: async () => new Response(JSON.stringify({
          requestId: "research-probe",
          searchType: "deep",
          results,
          output: { content: "A".repeat(500), grounding: [] },
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
      const tools = await createNovaTools({
        workspace: new LocalWorkspace(root),
        todos: new TodoList(),
        search,
      });
      const tool = tools.find((candidate) => candidate.name === "deep_research");
      if (!tool) throw new Error("deep_research was not registered for the probe");
      const result = await tool.execute({ query: "probe" }, { taskId: "probe", runId: "probe", stepId: "probe" });
      return result.content.length / (results.length * rawPerResult);
    },
  },
  {
    id: "provider.capability-coverage",
    layer: "provider",
    what: "Every hosted provider's own default model has an explicit capability policy",
    metric: "share of default models explicitly handled",
    budget: { min: 1 },
    baseline: { value: 1, on: "2026-08-22" },
    evidence: "providers/model-capabilities.ts KNOWN_CAPABILITIES, providers/provider-specs.ts",
    remediation:
      "A provider's default model shipped without an explicit capability row. Add its published limits when available; otherwise add a dated, conservative row so unknown limits cannot inherit another model family's optimistic budget.",
    measure: async () => {
      // Hosted providers only. A local Ollama model's window is whatever the user's own model file
      // and quantization say — there is no published number to put in a table, and the conservative
      // fallback is the correct, honest answer there rather than a gap to be closed.
      const defaults = Object.entries(PROVIDER_INFO)
        .filter(([id]) => id !== "ollama")
        .map(([, info]) => (info as { defaultModel?: string }).defaultModel)
        .filter((model): model is string => Boolean(model));
      if (defaults.length === 0) return 1;
      const known = defaults.filter((model) => capabilitiesFor(model) !== CONSERVATIVE_CAPABILITIES);
      return known.length / defaults.length;
    },
  },
  {
    id: "runtime.iteration-append-cap",
    layer: "runtime",
    what: "What a single iteration of parallel tool calls can append to the transcript",
    metric: "share of the total tool-result allowance",
    // Floored, because "nothing was appended" would satisfy any ceiling — and would mean the tools
    // stopped returning anything at all.
    budget: { min: 0.01, max: 0.3 },
    baseline: { value: 0.25, on: "2026-08-22" },
    evidence: "agent-runtime.ts iterationCharBudget",
    remediation:
      "Eight parallel calls at the per-call budget is ~107,000 tokens in one step — on a 200K model that is the context error, not a step towards it. Restore the per-iteration ceiling.",
    measure: async () => {
      // Four calls in one iteration, each with a result that would fill the per-call budget on its
      // own. Measuring one call would have proved nothing: the cap only exists for the pile-up.
      const budget = 10_000;
      const appended = await parallelIterationCost(4, budget, budget);
      return appended / (budget * 10);
    },
  },
  {
    id: "runtime.nudge-round-trips",
    layer: "runtime",
    what: "Model calls spent by a run whose evidence climbs from a typecheck to real tests",
    metric: "model calls",
    budget: { min: 3, max: 4 },
    baseline: { value: 4, on: "2026-08-22" },
    evidence: "agent-runtime.ts, the verification and evidence nudges",
    remediation:
      "Each nudge re-sends the entire transcript — a 114-token nudge costs 100,114 input tokens on a 100K conversation — so what matters is how many round trips deliver them, not their length. The test and behaviour rungs must keep riding in one message; walking the ladder one question per model call is what this number catches. A fall below the floor is the worse bug: it means the gate stopped asking at all.",
    measure: async () => nudgeRoundTrips(),
  },
  {
    id: "runtime.defender-forecast-premium",
    layer: "runtime",
    what: "How much more cumulative input the preflight reserves for a broad defender review than build work",
    metric: "ratio of expected input tokens",
    budget: { min: 1.3, max: 3 },
    baseline: { value: 1.983, on: "2026-08-23" },
    evidence: "nova-cli/cost.ts predictAgentUsage defender profile",
    remediation:
      "Restore defender's distinct forecast profile: playbook bodies, advisory research and broader inspection make its tool-result growth and iteration count materially higher than build. Actual provider usage remains accounting truth, but preflight must reserve honestly before spending starts.",
    measure: async () => {
      const objective = "audit the entire authentication and API surface";
      const build = predictAgentUsage({ initialInputTokens: 6_000, objective, mode: "build" });
      const defender = predictAgentUsage({ initialInputTokens: 6_000, objective, mode: "defender" });
      return defender.inputTokensExpected / build.inputTokensExpected;
    },
  },
  {
    id: "state.search-latency-p50",
    layer: "state",
    what: "Median search query served by the nova-state index",
    metric: "milliseconds",
    // Also rebased against the representative corpus, which is larger and carries journal documents.
    budget: { max: 3 },
    baseline: { value: 1.25, on: "2026-08-22" },
    evidence: "packages/nova-state/src/index.rs, `bun run bench:state`",
    remediation:
      "Run `bun run bench:state` and compare. The wins that got it here: ordering and truncating candidate rows before assembling evidence (a broad query was 271ms, now 36ms), and prepare_cached on the hot statements. A regression usually means evidence assembly crept back ahead of the truncation.",
  },
  {
    id: "state.index-throughput",
    layer: "state",
    what: "How fast a workspace's sessions, messages and event journals are indexed",
    metric: "documents per second",
    /**
     * Rebased, and the reason matters more than the number.
     *
     * The old figure — 62,268 docs/s — was measured against a corpus with no integrity digests and
     * no journals, neither of which a real workspace lacks. The benchmark now writes what the real
     * writer writes, so it also pays for digest verification (~1.8x the cost of parsing alone) and
     * for reading and chain-verifying journals, which together are ~20% of a rebuild and were
     * invisible before. The floor moved because the measurement got honest, not because the code
     * got slower; the two numbers are not comparable and the old one is not a target to chase.
     */
    budget: { min: 10_000 },
    baseline: { value: 23_980, on: "2026-08-22" },
    evidence: "packages/nova-state/src/index.rs rebuild_all / write_batch",
    remediation:
      "Run `bun run bench:state`. 94% of a rebuild used to be fsync — one durable commit per session. Sources are read outside the write transaction and written in batches of REBUILD_BATCH_ROWS; a per-session commit reintroduces a 13x slowdown. Also check the FTS deletes still go by rowid rather than `rowid IN (SELECT ...)`, which fts5 cannot optimise and which scanned the whole index once per session.",
  },
  {
    id: "state.source-parse-share",
    layer: "state",
    what: "Share of an index rebuild spent reading, verifying and parsing the source files",
    metric: "share of rebuild",
    budget: { min: 0.02, max: 0.4 },
    baseline: { value: 0.17, on: "2026-08-22" },
    evidence: "packages/nova-state/src/bin/nova-state-bench.rs · `sources.shareOfIndex`",
    remediation:
      "Reported by `bun run bench:state`. This is the work the benchmark could not see until its corpus carried integrity digests and journals: canonicalize + SHA-256 per snapshot, and a hash-chain verification per journal event. A rise means parsing or verification grew; a fall towards zero probably means the corpus stopped being representative again, which is the failure that hid this work in the first place.",
  },
  {
    id: "cli.workspace-walk",
    layer: "cli",
    what: "A full walk of the project tree, which backs glob, grep, list and skill discovery",
    metric: "milliseconds",
    budget: { max: 60 },
    // The probe's own warm-cache figure, which is what it will be compared against. The cold-cache
    // number this replaced was 41ms; both are in the remediation so neither is lost.
    baseline: { value: 6.1, on: "2026-08-22" },
    evidence: "nova-cli/workspace.ts walkWorkspace",
    remediation:
      "The walk reads a level of directories at once and yields them in queue order. A regression usually means it went back to awaiting one readdir at a time (41ms here, 302ms on a 3,000-directory tree) or that a large generated directory left ignoredDirectories. Budgets here are coarse on purpose — they catch a structural change, not a slow afternoon on a shared machine.",
    measure: async ({ root }) => {
      const { walkWorkspace } = await import("./workspace");
      const samples: number[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        const started = performance.now();
        let seen = 0;
        for await (const entry of walkWorkspace(root)) seen += entry.isDirectory ? 0 : 1;
        samples.push(performance.now() - started);
      }
      // These probes share a machine with the full test suite. The fastest warm sample represents
      // the implementation; a one-off scheduler or disk-contention stall does not. A structural
      // regression is slow on every sample and still crosses the deliberately coarse budget.
      return Math.min(...samples);
    },
  },
  {
    id: "cli.grep-latency",
    layer: "cli",
    what: "A literal content search across the project, as the grep_files tool performs it",
    metric: "milliseconds",
    budget: { max: 250 },
    // Warm-cache, measured by this probe. Cold, the same search was 401ms before these changes and
    // 93ms after — the structural win is in the remediation, this number is the regression guard.
    baseline: { value: 14, on: "2026-08-22" },
    evidence: "nova-cli/workspace.ts grepWorkspace",
    remediation:
      "Three things got it here and any of them regressing shows up as this number: generated directories excluded from ignoredDirectories (coverage/ alone was 30% of every byte read), files read concurrently rather than one at a time, and a raw Buffer.indexOf prefilter that rules a file out before decoding it into a line array (~3x the file's size, allocated and thrown away).",
    measure: async ({ root }) => {
      const { grepWorkspace } = await import("./workspace");
      await grepWorkspace(root, "compactionUrgency", {});
      const samples: number[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        const started = performance.now();
        await grepWorkspace(root, "compactionUrgency", {});
        samples.push(performance.now() - started);
      }
      return Math.min(...samples);
    },
  },
  {
    id: "cli.startup",
    layer: "cli",
    what: "Time from process start to an interactive prompt",
    metric: "milliseconds",
    budget: { max: 200 },
    evidence: "packages/nova-cli/src/nova.ts, tooling/build/cli-bundle.ts",
    remediation:
      "Two mechanisms, and both are load-bearing. The bundler must keep `splitting: true` with `.mjs` chunk naming, or Bun hoists every dynamically imported subtree into the entry file and the provider SDKs execute on `nova --help` (entry 3.90 MB vs 0.94 MB; 0.17s vs 0.12s measured). And the launcher (dist/nova.mjs) must stay a separate tiny file that calls module.enableCompileCache() before *dynamically* importing the main bundle — a static import is hoisted above the call and silently disables it. Measure with: `bun run build:cli` then time `node dist/nova.mjs --help`.",
  },
];

/** Runs every measurable target against the live code. Never throws: a probe that fails is a result. */
export async function runOptimizationProbes(context: ProbeContext, only?: readonly string[]): Promise<ProbeResult[]> {
  const selected = only?.length ? OPTIMIZATION_TARGETS.filter((target) => only.includes(target.id)) : OPTIMIZATION_TARGETS;
  const results: ProbeResult[] = [];
  for (const target of selected) {
    if (!target.measure) {
      results.push({ target, status: "unmeasured", detail: "No probe yet — measured by hand or by another suite." });
      continue;
    }
    try {
      const measured = await target.measure(context);
      const tooHigh = target.budget.max !== undefined && measured > target.budget.max;
      const tooLow = target.budget.min !== undefined && measured < target.budget.min;
      results.push({ target, status: tooHigh || tooLow ? "fail" : "pass", measured });
    } catch (error) {
      // An erroring probe is a broken probe, not a passing target. Saying so keeps the map honest.
      results.push({ target, status: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** The budget as a person reads it: `<= 6000 tokens`. */
export function describeBudget(target: OptimizationTarget): string {
  const parts: string[] = [];
  if (target.budget.max !== undefined) parts.push(`<= ${target.budget.max}`);
  if (target.budget.min !== undefined) parts.push(`>= ${target.budget.min}`);
  return `${parts.join(" and ")} ${target.metric}`;
}
