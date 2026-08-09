import { createHash } from "node:crypto";
import type { AgentTool, AgentToolCall } from "../agent-runtime";

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
} as const;

const MODE_CAPABILITIES: Record<NovaMode, string[]> = {
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
export const APPROVAL_POLICY_VERSION = "nova-approval-v1" as const;

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

/** Stable across object key order, but deliberately changes when any meaningful argument changes. */
export function actionDigest(call: AgentToolCall, tool: AgentTool): string {
  const action = JSON.stringify(canonicalize({
    policyVersion: APPROVAL_POLICY_VERSION,
    tool: tool.name,
    capabilityId: tool.capabilityId,
    effect: tool.effect,
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
    // `auto` pre-approves workspace changes but never external ones — sending an email or opening
    // a pull request is not undoable by a checkpoint, so it stays a human decision in every mode.
    if (this.mode === "auto" && tool.effect === "workspace") return "approved";

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
