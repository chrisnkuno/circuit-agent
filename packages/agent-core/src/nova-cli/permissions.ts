import { createHash } from "node:crypto";
import type { AgentTool, AgentToolCall } from "../agent-runtime";
import { assessToolSafety, type SafetyAssessment } from "./safety";

/**
 * Who decides whether a tool call runs.
 *
 * Cline's Plan/Act split is the model adopted here, for the reason it works: the expensive mistakes
 * an agent makes are not bad edits, they are confident edits made before it understood the problem.
 * A mode that physically cannot write forces the understanding to happen first.
 *
 * - `plan`  — read, search and think. No writes, no commands. Nothing to approve because nothing
 *             can change.
 * - `build` — full tool set, with every effectful call gated on a human decision.
 * - `auto`  — full tool set, workspace edits pre-approved, external actions still gated. For a
 *             disposable checkout or a trusted loop, never the default.
 */
export type NovaMode = "plan" | "build" | "auto";

export type PermissionDecision = "allow" | "allow_always" | "deny" | "deny_always";
export type ToolApprovalOutcome = "approved" | "denied";

/** Capability ids the runtime scopes tools by, mirrored from `lib/capability-registry.ts`. */
export const NOVA_CAPABILITIES = {
  read: "workspace.files.read",
  write: "workspace.files",
  terminal: "workspace.terminal",
  research: "web.research",
  planning: "reasoning.plan",
  /** Skill, MCP and plugin tools — code Nova did not ship, running with the user's approval. */
  external: "workspace.external",
} as const;

const MODE_CAPABILITIES: Record<NovaMode, string[]> = {
  // No externally-sourced tool runs in plan mode: plan already permits nothing that changes
  // anything, and a skill/MCP/plugin tool is by definition not one of the effects plan already
  // reasoned about (it could shell out, write files, or call a network service under the hood).
  plan: [NOVA_CAPABILITIES.read, NOVA_CAPABILITIES.research, NOVA_CAPABILITIES.planning],
  build: Object.values(NOVA_CAPABILITIES),
  auto: Object.values(NOVA_CAPABILITIES),
};

export function capabilitiesForMode(mode: NovaMode): string[] {
  return [...MODE_CAPABILITIES[mode]];
}

export type ApprovalRequest = {
  call: AgentToolCall;
  tool: AgentTool;
  /** One line a human can act on without reading JSON — "edit src/app.ts", "run npm test". */
  summary: string;
  /** Exact proposed action. Recomputed before every lookup, so changed arguments need consent. */
  actionDigest: string;
  /** Versioned authorization key persisted by `allow_always` / `deny_always`. */
  scopeKey: string;
  policyVersion: typeof APPROVAL_POLICY_VERSION;
  /** Why auto mode did not silently approve this otherwise-workspace-local action. */
  safety: SafetyAssessment;
};

export type ApprovalPrompt = (request: ApprovalRequest) => Promise<PermissionDecision>;

/**
 * Remembers standing decisions for the exact normalized action, not merely its tool name.
 *
 * Approval fatigue is a safety problem, not an ergonomics one: an agent that asks forty times
 * trains the human to press `y` without reading, which is strictly worse than asking twice.
 * A changed path, command, argument or effect creates a different digest and must be considered
 * again. This is intentionally narrower than Cline-style UI categories: categories are useful for
 * presentation, but too broad to be authorization keys.
 */
export const APPROVAL_POLICY_VERSION = "nova-approval-v2" as const;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Approval arguments contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`Approval arguments contain unsupported ${typeof value} value`);
}

/**
 * Stable across object key order, but deliberately changes when any meaningful argument changes —
 * including, since `APPROVAL_POLICY_VERSION` bumped to v2, a tool's provenance. A standing
 * `allow_always` for `write_file` was granted to Nova's own built-in tool; if a same-named tool
 * later arrives from an MCP server or a skill file, that is a different actor making the same-shaped
 * request, and the old approval must not silently cover it. The version bump means every decision
 * made under v1 is void regardless of provenance — the honest way to close the gap for tools that
 * were already approved before this field existed, rather than guessing which of them would still
 * have been approved knowingly.
 */
export function actionDigest(call: AgentToolCall, tool: AgentTool): string {
  const action = JSON.stringify(canonicalize({
    policyVersion: APPROVAL_POLICY_VERSION,
    tool: tool.name,
    capabilityId: tool.capabilityId,
    effect: tool.effect,
    provenance: tool.provenance ?? { kind: "built-in" },
    arguments: call.arguments ?? {},
  }));
  return createHash("sha256").update(action).digest("hex");
}

export function approvalScopeKey(call: AgentToolCall, tool: AgentTool): string {
  return `${APPROVAL_POLICY_VERSION}:${actionDigest(call, tool)}`;
}

export class PermissionLedger {
  private readonly standing = new Map<string, "allow" | "deny">();
  /** Old broad denials remain safe; old broad allows are intentionally not migrated. */
  private readonly legacyDeniedTools = new Set<string>();

  constructor(private readonly mode: NovaMode, private readonly prompt: ApprovalPrompt) {}

  /** Standing decisions made so far, for display and for session persistence. */
  snapshot(): Record<string, "allow" | "deny"> {
    return Object.fromEntries(this.standing);
  }

  restore(decisions: Record<string, "allow" | "deny">): void {
    for (const [scope, decision] of Object.entries(decisions)) {
      if (scope.startsWith(`${APPROVAL_POLICY_VERSION}:`)) this.standing.set(scope, decision);
      else if (decision === "deny") this.legacyDeniedTools.add(scope);
    }
  }

  async isApproved(call: AgentToolCall, tool: AgentTool): Promise<boolean> {
    return (await this.decide(call, tool)) === "approved";
  }

  /** Rich outcome lets the runtime distinguish a real rejection from an unresolved request. */
  async decide(call: AgentToolCall, tool: AgentTool): Promise<ToolApprovalOutcome> {
    // A tool that changes nothing needs no gate; the runtime only asks about the ones that do.
    if (tool.effect === "none") return "approved";
    // Auto mode is an ergonomics feature, not a blanket trust grant. Inspect the exact command,
    // path and content before taking its fast path; credentials, production configuration and
    // high-impact commands remain explicit human decisions.
    const safety = assessToolSafety(call, tool);
    if (this.mode === "auto" && tool.effect === "workspace" && !safety.sensitive) return "approved";

    if (this.legacyDeniedTools.has(tool.name)) return "denied";
    const action = actionDigest(call, tool);
    const scopeKey = `${APPROVAL_POLICY_VERSION}:${action}`;
    const standing = this.standing.get(scopeKey);
    if (standing) return standing === "allow" ? "approved" : "denied";

    const decision = await this.prompt({
      call,
      tool,
      summary: describeToolCall(call, tool),
      actionDigest: action,
      scopeKey,
      policyVersion: APPROVAL_POLICY_VERSION,
      safety,
    });
    if (decision === "allow_always") this.standing.set(scopeKey, "allow");
    if (decision === "deny_always") this.standing.set(scopeKey, "deny");
    return decision === "allow" || decision === "allow_always" ? "approved" : "denied";
  }
}

/** Human-readable one-liner for an approval prompt or a transcript line. */
export function describeToolCall(call: AgentToolCall, tool: AgentTool): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
  switch (call.name) {
    case "write_file":
      return `write ${asString(args.path) ?? "a file"}`;
    case "edit_file":
      return `edit ${asString(args.path) ?? "a file"}`;
    case "run_command": {
      const program = asString(args.command) ?? "a command";
      return `run ${program}`;
    }
    default:
      return `${tool.name}${args.path ? ` ${asString(args.path)}` : ""}`;
  }
}
