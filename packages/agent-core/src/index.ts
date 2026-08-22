/**
 * The public surface of the agent core.
 *
 * Deliberately a short list of entry points rather than a re-export of everything: a package whose
 * index exposes every internal module has no seam to change behind. Anything not named here is
 * still reachable at its own subpath (`@circuit-nova/nova-core/providers/e2b`), which keeps the boundary
 * honest without making internals unreachable during the transition.
 */

export { BoundedAgentRuntime, validateHistory } from "./agent-runtime";
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
  ToolProvenance,
  StoredToolArtifact,
  ToolResultArtifactStore,
} from "./agent-runtime";
export { evictedToolResult } from "./agent-runtime";
export { WorkspaceArtifactStore, artifactPathFor, ARTIFACT_DIRECTORY, MAX_ARTIFACT_BYTES } from "./nova-cli/artifacts";

export { NovaAgent, DEFAULT_NOVA_BUDGETS } from "./nova-cli/agent";
export type { NovaAgentOptions, NovaBudgets, NovaEvent, NovaTurnResult } from "./nova-cli/agent";

export { LocalWorkspace, E2BWorkspace, DockerWorkspace, uploadProject, downloadProject } from "./nova-cli/backends";
export type { NovaWorkspace } from "./nova-cli/backends";

export { createNovaTools, TodoList } from "./nova-cli/tools";
export type { TodoItem } from "./nova-cli/tools";

// Tools Nova did not ship with: skills, hooks, plugins and MCP servers. Exported because
// implementing a `ToolProvider` is the supported way for a consumer of this package to add its own
// tool source — without these an embedder can only use the built-in set.
export { collectExternalTools, toolsFromProvider } from "./nova-cli/tool-providers";
export type { ExternalTool, ToolProvider, ToolProviderKind } from "./nova-cli/tool-providers";
export { discoverSkillManifests, discoverSkillManifestsIn, parseSkillManifest, substitutePlaceholders, SkillToolProvider, SKILLS_DIRECTORY } from "./nova-cli/skills";
export type { SkillManifest } from "./nova-cli/skills";
export { HookRegistry, HOOKS_DIRECTORY } from "./nova-cli/hooks";
export type { HookEvent, HookSource, PreToolUseOutcome } from "./nova-cli/hooks";
export { discoverMcpServers, parseMcpServerConfig, McpConnection, McpToolProvider } from "./nova-cli/mcp-provider";
export type { McpServerConfig } from "./nova-cli/mcp-provider";
export { discoverPlugins, parsePluginManifest, PLUGINS_DIRECTORY } from "./nova-cli/plugins";
export type { PluginManifest } from "./nova-cli/plugins";
export { loadLocalExternalTooling, IMPLICIT_SKILL_PROVIDER_ID } from "./nova-cli/external-tools";
export type { LocalExternalTooling } from "./nova-cli/external-tools";
export { PermissionLedger, actionDigest, approvalScopeKey, capabilitiesForMode } from "./nova-cli/permissions";
export type { NovaMode, PermissionDecision, ToolApprovalOutcome } from "./nova-cli/permissions";
export { assessTaskSafety, assessToolSafety } from "./nova-cli/safety";
export type { SafetyAssessment, SensitiveCategory } from "./nova-cli/safety";
export { CheckpointStore } from "./nova-cli/checkpoints";
export { CostLedger } from "./nova-cli/cost";
export { CircuitPayGateway, BillingError, billingFromEnvironment, parseAmountRwf, assertTopUpAmount, newIdempotencyKey, waitForPayment, isPaymentSettled, MINIMUM_TOP_UP_RWF, MAXIMUM_TOP_UP_RWF } from "./nova-cli/billing";
export type { Balance, BillingGateway, Checkout, CheckoutRequest, Payment, PaymentStatus, WaitResult } from "./nova-cli/billing";
export { listSessions, loadSession, saveSession } from "./nova-cli/session";
export { NovaStateClient, NovaStateError, resolveNovaStateBinary, statePlatformKey, tryConnectNovaState, NOVA_STATE_PROTOCOL_VERSION } from "./nova-cli/state-client";
export type { NovaStateClientOptions, StateContextDocument, StateEvidenceSource, StateIndexReport, StateSearchHit, StateSessionSummary } from "./nova-cli/state-client";
export { assertTurnTransition, EventJournal, readEventJournal, runtimeEventForJournal, NOVA_PROTOCOL_VERSION } from "./nova-cli/protocol";
export type { NovaEventEnvelope, NovaProtocolPayload, TurnStatus } from "./nova-cli/protocol";
export { NovaDaemonClient, NovaSessionDaemon, NOVA_DAEMON_PROTOCOL_VERSION } from "./nova-cli/daemon";
export type {
  DaemonAgentFactory,
  DaemonAgentFactoryContext,
  DaemonApprovalRequest,
  DaemonNotification,
  DaemonSessionInfo,
} from "./nova-cli/daemon";

export { resolveProvider, describeProviders, availableProviders, PROVIDERS, PROVIDER_IDS } from "./providers/agent-matrix";
export type { ProviderId, ProviderSpec, ProviderStatus } from "./providers/agent-matrix";

export { convertTo, formatMoney, fromUnits, priceUsage, tokenPrices } from "./money";
export type { Currency, FxRate, Money, TokenPrices } from "./money";

export { cancel, claim, consumeApproval, detach, emptyStore, enqueue, finish, heartbeat, isTerminal, recoverStale, requestApproval, resolveApproval, summarize, MAX_ATTEMPTS } from "./nova-cli/jobs";
export type { ApprovalRequest, Job, JobLease, JobStatus, JobStore, JobSummary } from "./nova-cli/jobs";

export {
  appendJobLog,
  cancelJob,
  claimJob,
  consumeJobApproval,
  detachJob,
  enqueueJob,
  finishJob,
  getJob,
  heartbeatJob,
  jobLogPath,
  jobStoreFile,
  listJobs,
  newJobId,
  readJobLog,
  requestJobApproval,
  resolveJobApproval,
  withJobs,
} from "./nova-cli/job-store";

export { definePrices, priceAliases, selectPrice, tokenPricesAt, tokenPricesFor, validatePriceRecord } from "./pricing";
export type { BillingUnit, PriceModality, PriceQuery, PriceRecord } from "./pricing";
export { PRICE_CATALOG } from "./providers/price-catalog";

// The suggestion engine both front ends read: what to do next, why now, and the ambient hints that
// teach the rest of the product. Exported because a suggestion that exists only in the CLI is the
// exact failure the shared rules were written to end.
export {
  CATEGORY_ORDER,
  classifyFailure,
  defaultSignals,
  mergeModelSuggestions,
  shouldOfferStarters,
  starterSuggestions,
  suggest,
  suggestionIds,
} from "./nova-cli/suggestions";
export type {
  DesktopActionId,
  FailureKind,
  SessionSignals,
  Suggestion,
  SuggestionAction,
  SuggestionCategory,
  SuggestionSurface,
  SuggestOptions,
} from "./nova-cli/suggestions";
