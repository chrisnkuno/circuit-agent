/**
 * The public surface of the agent core.
 *
 * Deliberately a short list of entry points rather than a re-export of everything: a package whose
 * index exposes every internal module has no seam to change behind. Anything not named here is
 * still reachable at its own subpath (`circuit-nova-core/providers/e2b`), which keeps the boundary
 * honest without making internals unreachable during the transition.
 */

export { BoundedAgentRuntime } from "./agent-runtime";
export type {
  AgentMessage,
  AgentModelRequest,
  AgentModelTurn,
  AgentRuntimeControl,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentTurnProvider,
} from "./agent-runtime";

export { NovaAgent, DEFAULT_NOVA_BUDGETS } from "./nova-cli/agent";
export type { NovaAgentOptions, NovaBudgets, NovaEvent, NovaTurnResult } from "./nova-cli/agent";

export { LocalWorkspace, E2BWorkspace, uploadProject, downloadProject } from "./nova-cli/backends";
export type { NovaWorkspace } from "./nova-cli/backends";

export { createNovaTools, TodoList } from "./nova-cli/tools";
export { PermissionLedger, capabilitiesForMode } from "./nova-cli/permissions";
export type { NovaMode, PermissionDecision } from "./nova-cli/permissions";
export { CheckpointStore } from "./nova-cli/checkpoints";
export { CostLedger } from "./nova-cli/cost";
export { listSessions, loadSession, saveSession } from "./nova-cli/session";

export { resolveProvider, describeProviders, availableProviders, PROVIDERS, PROVIDER_IDS } from "./providers/agent-matrix";
export type { ProviderId, ProviderSpec, ProviderStatus } from "./providers/agent-matrix";

export { convertTo, formatMoney, fromUnits, priceUsage, tokenPrices } from "./money";
export type { Currency, FxRate, Money, TokenPrices } from "./money";
