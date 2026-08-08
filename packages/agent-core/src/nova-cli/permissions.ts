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
};

export type ApprovalPrompt = (request: ApprovalRequest) => Promise<PermissionDecision>;

/**
 * Remembers standing decisions so a person is asked once per kind of action, not once per call.
 *
 * Approval fatigue is a safety problem, not an ergonomics one: an agent that asks forty times
 * trains the human to press `y` without reading, which is strictly worse than asking twice.
 * Decisions are keyed by tool name, so "always allow reads" never silently also allows writes.
 */
export class PermissionLedger {
  private readonly standing = new Map<string, "allow" | "deny">();

  constructor(private readonly mode: NovaMode, private readonly prompt: ApprovalPrompt) {}

  /** Standing decisions made so far, for display and for session persistence. */
  snapshot(): Record<string, "allow" | "deny"> {
    return Object.fromEntries(this.standing);
  }

  restore(decisions: Record<string, "allow" | "deny">): void {
    for (const [tool, decision] of Object.entries(decisions)) this.standing.set(tool, decision);
  }

  async isApproved(call: AgentToolCall, tool: AgentTool): Promise<boolean> {
    // A tool that changes nothing needs no gate; the runtime only asks about the ones that do.
    if (tool.effect === "none") return true;
    // `auto` pre-approves workspace changes but never external ones — sending an email or opening
    // a pull request is not undoable by a checkpoint, so it stays a human decision in every mode.
    if (this.mode === "auto" && tool.effect === "workspace") return true;

    const standing = this.standing.get(tool.name);
    if (standing) return standing === "allow";

    const decision = await this.prompt({ call, tool, summary: describeToolCall(call, tool) });
    if (decision === "allow_always") this.standing.set(tool.name, "allow");
    if (decision === "deny_always") this.standing.set(tool.name, "deny");
    return decision === "allow" || decision === "allow_always";
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
