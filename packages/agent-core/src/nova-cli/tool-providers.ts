import type { AgentTool, ToolProvenance } from "../agent-runtime";
import { NOVA_CAPABILITIES } from "./permissions";
import { assertSupportedSchema, type ToolInputSchema } from "./tool-schema";

/**
 * A single tool as an externally-sourced provider describes it — a plain data-plus-invoke shape,
 * deliberately not `AgentTool` itself. A provider (a skill file, an MCP server, a plugin) does not
 * know about Nova's approval gating, capability scoping or provenance tagging; `toolsFromProvider`
 * is the one place that turns its description into something the runtime can actually schedule,
 * the same separation `providers/contracts.ts` draws between an external service's own shape and
 * what Nova's code needs from it.
 */
export type ExternalTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(argumentsValue: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
};

export type ToolProviderKind = "skill" | "mcp" | "plugin";

/**
 * Something that can list and run tools Nova did not ship with.
 *
 * `id` is the provenance key: two providers of the same kind (two MCP servers, two plugins) must
 * have distinct ids, since `id` is what `actionDigest` uses to tell them apart — a standing approval
 * for one must never quietly cover the other.
 */
export interface ToolProvider {
  readonly id: string;
  readonly kind: ToolProviderKind;
  listTools(): Promise<ExternalTool[]>;
}

const DEFAULT_EXTERNAL_TOOL_TIMEOUT_MS = 30_000;

/**
 * Wraps a provider's tools as `AgentTool`s: external effect, always gated on approval (the runtime
 * itself enforces this — `BoundedAgentRuntime`'s constructor throws if an external-effect tool ever
 * claims `requiresApproval: false`), tagged with provenance, and defensively timed out — a provider
 * is code Nova does not control, and a hang in it must not hang the whole agent turn. `timeoutMs` is
 * a parameter (not only the default) so a test can prove the timeout fires without waiting 30s for it.
 *
 * Two tools from different providers sharing a name is resolved by the caller (`createNovaTools`),
 * which throws on the duplicate before construction — the same rule `BoundedAgentRuntime` already
 * enforces for its own tool map, applied one step earlier so the error names which provider caused it.
 */
export async function toolsFromProvider(provider: ToolProvider, timeoutMs = DEFAULT_EXTERNAL_TOOL_TIMEOUT_MS): Promise<AgentTool[]> {
  const externalTools = await provider.listTools();
  const provenance: ToolProvenance = { kind: provider.kind, providerId: provider.id };
  return externalTools.map((externalTool) => {
    assertSupportedSchema(externalTool.name, externalTool.inputSchema);
    return {
      name: externalTool.name,
      description: externalTool.description,
      inputSchema: externalTool.inputSchema as ToolInputSchema,
      capabilityId: NOVA_CAPABILITIES.external,
      effect: "external" as const,
      requiresApproval: true,
      parallelSafe: false,
      provenance,
      async execute(argumentsValue) {
        const result = await Promise.race([
          externalTool.invoke(argumentsValue),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${provider.kind} tool '${externalTool.name}' (${provider.id}) timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        return result;
      },
    };
  });
}

/**
 * Merges every provider's tools into one list, failing loudly on a name collision rather than
 * letting the second registration silently shadow the first — a shadowed tool is a provider whose
 * calls are silently routed to a different implementation than the one the model was told about.
 */
export async function collectExternalTools(providers: readonly ToolProvider[], timeoutMs?: number): Promise<AgentTool[]> {
  const collected: AgentTool[] = [];
  const seenNames = new Map<string, string>();
  // Providers are asked concurrently — an MCP server's `tools/list` is a network round trip, and
  // five of them one after another was five round trips of latency on the turn's critical path.
  // The *merge* stays sequential in `providers` order, so which provider wins a name collision (and
  // therefore which error is raised) does not depend on who answered first.
  const listings = await Promise.all(providers.map((provider) => toolsFromProvider(provider, timeoutMs)));
  for (const [index, provider] of providers.entries()) {
    for (const tool of listings[index]) {
      const existing = seenNames.get(tool.name);
      if (existing) throw new Error(`Tool name '${tool.name}' is offered by both ${existing} and ${provider.kind}:${provider.id}`);
      seenNames.set(tool.name, `${provider.kind}:${provider.id}`);
      collected.push(tool);
    }
  }
  return collected;
}
