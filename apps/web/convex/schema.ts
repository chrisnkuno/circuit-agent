import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),
  memberships: defineTable({
    organizationId: v.id("organizations"),
    identitySubject: v.string(),
    // Where lifecycle notifications go. Optional because it is only known once the member has
    // signed in at least since this field existed; a member without one is simply not emailed
    // rather than emailed at a guessed address.
    notificationEmail: v.optional(v.string()),
    // Presentation preferences only. Every budget, reservation, and settlement remains an
    // integer RWF amount; these fields choose how that authoritative ledger is displayed.
    countryCode: v.optional(v.string()),
    currencyCode: v.optional(v.string()),
    currencySource: v.optional(v.union(v.literal("automatic"), v.literal("manual"))),
    moneyPreferencesUpdatedAt: v.optional(v.number()),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer")),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_organization_subject", ["organizationId", "identitySubject"])
    .index("by_subject", ["identitySubject"]),
  tasks: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    kind: v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations")),
    status: v.union(v.literal("draft"), v.literal("quoted"), v.literal("awaiting_approval"), v.literal("running"), v.literal("completed"), v.literal("blocked"), v.literal("cancelled")),
    quality: v.union(v.literal("fast"), v.literal("balanced"), v.literal("expert")),
    maxRwf: v.int64(),
    spentRwf: v.int64(),
    reservedRwf: v.int64(),
    expectedOutput: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_status", ["status"]).index("by_organization", ["organizationId"]),
  taskQuotes: defineTable({
    taskId: v.id("tasks"),
    version: v.number(),
    estimateLowRwf: v.int64(),
    estimateHighRwf: v.int64(),
    maxRwf: v.int64(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    assumptions: v.array(v.string()),
    estimatorVersion: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),
  paymentHolds: defineTable({
    taskId: v.id("tasks"),
    amountRwf: v.int64(),
    provider: v.literal("circuit_pay"),
    providerReference: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("authorized"), v.literal("captured"), v.literal("released"), v.literal("refunded")),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]).index("by_idempotency_key", ["idempotencyKey"]),
  // Inbound provider webhooks retry on any non-2xx (E2B: three times, ten seconds apart), so
  // duplicate deliveries are routine. The provider's own delivery id is the idempotency key.
  webhookDeliveries: defineTable({
    provider: v.literal("e2b"),
    deliveryId: v.string(),
    eventType: v.string(),
    sandboxId: v.optional(v.string()),
    /** The provider's own runtime figure for this event, kept for comparison with ours. */
    reportedExecutionMs: v.optional(v.number()),
    receivedAt: v.number(),
  }).index("by_provider_delivery", ["provider", "deliveryId"]),
  taskEvents: defineTable({
    taskId: v.id("tasks"),
    type: v.string(),
    message: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),
  agentRuns: defineTable({
    // The workspace preset this run was started with (lib/sandbox-templates.ts). Held on the run
    // because every step of it must land in the same kind of workspace, and because the planner is
    // told what that workspace contains.
    workspacePresetId: v.optional(v.string()),
    modelProvider: v.optional(v.union(v.literal("openai"), v.literal("circuitnotion"))),
    modelId: v.optional(v.string()),
    // The sandbox this run is working in, carried across its steps. Recorded as soon as a worker
    // reports one so an abandoned sandbox is still known to the system that must destroy it.
    sandboxId: v.optional(v.string()),
    /** A completed app workspace remains resumable for a bounded preview window. */
    previewExpiresAt: v.optional(v.number()),
    // Billable sandbox runtime, accumulated from E2B's own lifecycle events: the sandbox is only
    // running between a create/resume and the next pause/kill, and only that time is charged.
    // Measured as wall clock between those events rather than taken from the provider's
    // `execution_time`, whose documentation does not say whether it is per-segment or cumulative;
    // the provider's figure is recorded separately so the two can be compared.
    sandboxMs: v.optional(v.number()),
    sandboxReportedMs: v.optional(v.number()),
    /** Set while the sandbox is actually running, so a pause knows what interval to close. */
    sandboxRunningSince: v.optional(v.number()),
    taskId: v.id("tasks"),
    parentRunId: v.optional(v.id("agentRuns")),
    delegationDepth: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations"))),
    role: v.union(v.literal("planner"), v.literal("coding"), v.literal("reviewer"), v.literal("research"), v.literal("operator")),
    // "paused" is a deliberate hold, not a failure: the run keeps its place, its budget, and its
    // suspended sandbox, and resumes into the same workspace. It exists because a suspended
    // sandbox is free to keep, so stopping to look at something no longer has to mean giving up.
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("paused"), v.literal("awaiting_approval"), v.literal("blocked"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"), v.literal("needs_configuration")),
    objective: v.string(),
    /**
     * Prefetched Wander evidence dossier (Exa highlights). Fetched once per run on the
     * control plane — never from a model tool loop — and injected into the planner context.
     */
    researchBrief: v.optional(v.string()),
    capabilityIds: v.optional(v.array(v.string())),
    maxParallelism: v.number(),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    cancelRequestedAt: v.optional(v.number()),
  }).index("by_task", ["taskId"]).index("by_status", ["status"]).index("by_sandbox", ["sandboxId"]),
  /**
   * Topic-keyed Exa dossier cache so a repeated Wander topic (e.g. a fixed weekly schedule)
   * does not pay for a fresh search within the TTL.
   */
  wanderEvidenceCache: defineTable({
    topicHash: v.string(),
    topic: v.string(),
    query: v.string(),
    briefMarkdown: v.string(),
    sourceCount: v.number(),
    exaRequestId: v.optional(v.string()),
    fetchedAt: v.number(),
  }).index("by_topic_hash", ["topicHash"]),
  agentSteps: defineTable({
    runId: v.id("agentRuns"),
    stepKey: v.string(),
    title: v.string(),
    role: v.union(v.literal("planner"), v.literal("coding"), v.literal("reviewer"), v.literal("research"), v.literal("operator")),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("running"), v.literal("awaiting_approval"), v.literal("completed"), v.literal("failed"), v.literal("blocked"), v.literal("cancelled")),
    dependsOn: v.array(v.string()),
    requiresApproval: v.boolean(),
    sandboxTemplate: v.optional(v.union(v.literal("coding"), v.literal("browser"), v.literal("data"))),
    capabilityIds: v.optional(v.array(v.string())),
    approvalStatus: v.optional(v.union(v.literal("not_required"), v.literal("pending"), v.literal("approved"), v.literal("rejected"))),
    attempts: v.number(),
    claimedBy: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    sandboxId: v.optional(v.string()),
    reservedRwf: v.optional(v.int64()),
    completedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    artifactReferences: v.optional(v.array(v.string())),
    createdAt: v.number(),
  }).index("by_run", ["runId"]).index("by_run_step_key", ["runId", "stepKey"]).index("by_status_lease", ["status", "leaseExpiresAt"]).index("by_sandbox", ["sandboxId"]),
  agentArtifacts: defineTable({
    taskId: v.id("tasks"),
    runId: v.id("agentRuns"),
    stepId: v.id("agentSteps"),
    kind: v.union(v.literal("model_plan"), v.literal("command_log"), v.literal("patch"), v.literal("test_log"), v.literal("review_summary"), v.literal("workspace_file")),
    mediaType: v.string(),
    reference: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
    // The content itself. Optional only because rows written before evidence was retrievable have
    // none: until this existed, every artifact recorded a hash of work nobody could ever read back.
    storageId: v.optional(v.id("_storage")),
    /** Workspace-relative path, for artifacts that are a file the step produced. */
    path: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]).index("by_run", ["runId"]).index("by_step", ["stepId"]).index("by_reference", ["reference"]),
  agentRunEvents: defineTable({
    runId: v.id("agentRuns"),
    type: v.string(),
    message: v.string(),
    createdAt: v.number(),
  }).index("by_run", ["runId"]),
  approvals: defineTable({
    // Denormalized from the owning task so pending approvals can be read per organization.
    // Optional only to keep rows written before this field was added readable; every new row
    // sets it. Without it, listing one organization's approvals meant scanning every pending
    // approval in the deployment and filtering in JS — work that grows with other tenants'
    // load and stops working entirely past Convex's 1024-document collect ceiling.
    organizationId: v.optional(v.id("organizations")),
    taskId: v.id("tasks"),
    runId: v.optional(v.id("agentRuns")),
    stepId: v.optional(v.id("agentSteps")),
    actionIntentId: v.optional(v.id("connectorActionIntents")),
    // "task_start" is the cost gate: a quoted task exists and is priced, but nothing is spent
    // until a person accepts the quote. Accepting it is what authorizes the payment hold.
    kind: v.union(v.literal("task_start"), v.literal("execute_step"), v.literal("budget_overage"), v.literal("merge"), v.literal("deploy"), v.literal("external_action")),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("expired")),
    requestedRwf: v.optional(v.int64()),
    requestedAt: v.number(),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.string()),
  }).index("by_task", ["taskId"]).index("by_status", ["status"]).index("by_organization_status", ["organizationId", "status"]),
  usageLedger: defineTable({
    taskId: v.id("tasks"),
    runId: v.optional(v.id("agentRuns")),
    stepId: v.optional(v.id("agentSteps")),
    provider: v.string(),
    meter: v.string(),
    quantity: v.number(),
    amountRwf: v.int64(),
    providerReference: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]).index("by_idempotency_key", ["idempotencyKey"]),
  connectorConnections: defineTable({
    organizationId: v.id("organizations"),
    connectorId: v.string(),
    status: v.union(v.literal("pending"), v.literal("connected"), v.literal("degraded"), v.literal("revoked"), v.literal("expired")),
    permissions: v.array(v.union(v.literal("read"), v.literal("draft"), v.literal("execute"))),
    credentialReference: v.string(),
    externalAccountLabel: v.optional(v.string()),
    scopes: v.array(v.string()),
    connectedAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.optional(v.number()),
  }).index("by_organization", ["organizationId"])
    .index("by_organization_connector", ["organizationId", "connectorId"]),
  connectorActionIntents: defineTable({
    organizationId: v.id("organizations"),
    taskId: v.id("tasks"),
    runId: v.optional(v.id("agentRuns")),
    stepId: v.optional(v.id("agentSteps")),
    connectionId: v.id("connectorConnections"),
    connectorId: v.string(),
    actionId: v.string(),
    permission: v.union(v.literal("read"), v.literal("draft"), v.literal("execute")),
    risk: v.union(v.literal("read"), v.literal("write"), v.literal("send"), v.literal("control"), v.literal("purchase"), v.literal("delete")),
    status: v.union(v.literal("proposed"), v.literal("awaiting_approval"), v.literal("approved"), v.literal("executing"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    idempotencyKey: v.string(),
    inputSummary: v.string(),
    payloadReference: v.optional(v.string()),
    outputSummary: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_task", ["taskId"])
    .index("by_status", ["status"])
    .index("by_idempotency_key", ["idempotencyKey"]),
  connectorEvents: defineTable({
    organizationId: v.id("organizations"),
    connectionId: v.optional(v.id("connectorConnections")),
    actionIntentId: v.optional(v.id("connectorActionIntents")),
    type: v.string(),
    message: v.string(),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_connection", ["connectionId"])
    .index("by_action_intent", ["actionIntentId"]),
  agentSchedules: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    workflowTemplate: v.string(),
    cronExpression: v.string(),
    timezone: v.string(),
    status: v.union(v.literal("paused"), v.literal("active"), v.literal("disabled")),
    connectorIds: v.array(v.string()),
    /** Only meaningful for the "coding-task" template: the objective run on every occurrence. */
    objective: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_status_next_run", ["status", "nextRunAt"]),
  channelLinkAttempts: defineTable({
    organizationId: v.id("organizations"),
    identitySubject: v.string(),
    channel: v.union(v.literal("telegram")),
    codeHash: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_code_hash", ["codeHash"])
    .index("by_organization", ["organizationId"]),
  channelLinks: defineTable({
    organizationId: v.id("organizations"),
    channel: v.union(v.literal("telegram")),
    channelUserId: v.string(),
    status: v.union(v.literal("linked"), v.literal("revoked")),
    linkedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_channel_user", ["channel", "channelUserId"]),
  conversations: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    kind: v.literal("nova"),
    status: v.union(v.literal("active"), v.literal("archived")),
    lastMessagePreview: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization_updated", ["organizationId", "updatedAt"]),
  conversationMessages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    sender: v.union(v.literal("user"), v.literal("nova"), v.literal("system")),
    content: v.string(),
    status: v.union(v.literal("sent"), v.literal("generating"), v.literal("failed")),
    clientMessageId: v.optional(v.string()),
    replyToMessageId: v.optional(v.id("conversationMessages")),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_conversation_created", ["conversationId", "createdAt"])
    .index("by_conversation_client", ["conversationId", "clientMessageId"]),
  novaPreferences: defineTable({
    organizationId: v.id("organizations"),
    provider: v.union(v.literal("deployment"), v.literal("openai"), v.literal("circuitnotion")),
    modelId: v.optional(v.string()),
    mode: v.union(v.literal("ask"), v.literal("plan"), v.literal("build")),
    memoryEnabled: v.boolean(),
    /**
     * The most this workspace will spend on one sandbox without stopping to ask. Optional because
     * it postdates the table: an absent value means the default ceiling, never "never automate"
     * (see lib/automation-budget.ts).
     */
    autoApproveUnderRwf: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),
  connectorVaultEntries: defineTable({
    organizationId: v.id("organizations"),
    kind: v.union(v.literal("oauth_tokens"), v.literal("oauth_pkce"), v.literal("action_payload")),
    algorithm: v.literal("aes-256-gcm"),
    keyVersion: v.number(),
    iv: v.string(),
    ciphertext: v.string(),
    authTag: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),
  connectorOAuthStates: defineTable({
    organizationId: v.id("organizations"),
    identitySubject: v.string(),
    connectorId: v.string(),
    stateHash: v.string(),
    pkceReference: v.string(),
    redirectUri: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_state_hash", ["stateHash"])
    .index("by_organization", ["organizationId"]),
  calendarWatchChannels: defineTable({
    organizationId: v.id("organizations"),
    connectionId: v.id("connectorConnections"),
    channelId: v.string(),
    resourceId: v.string(),
    tokenHash: v.string(),
    status: v.union(v.literal("active"), v.literal("expired"), v.literal("stopped")),
    expiration: v.number(),
    lastMessageNumber: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_channel_id", ["channelId"])
    .index("by_connection", ["connectionId"])
    .index("by_expiration", ["status", "expiration"]),
  skills: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    version: v.number(),
    title: v.string(),
    taskKind: v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations")),
    proceduralSummary: v.string(),
    sourceRunId: v.id("agentRuns"),
    sourceObjective: v.string(),
    status: v.union(v.literal("proposed"), v.literal("approved"), v.literal("rejected"), v.literal("retired")),
    createdAt: v.number(),
    updatedAt: v.number(),
    decidedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
  }).index("by_organization", ["organizationId"])
    .index("by_organization_status", ["organizationId", "status"])
    .index("by_organization_slug", ["organizationId", "slug"]),
  githubInstallAttempts: defineTable({
    organizationId: v.id("organizations"),
    identitySubject: v.string(),
    stateHash: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_state_hash", ["stateHash"])
    .index("by_organization", ["organizationId"]),
  githubInstallations: defineTable({
    organizationId: v.id("organizations"),
    installationId: v.string(),
    accountLogin: v.string(),
    accountType: v.union(v.literal("Organization"), v.literal("User")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    allowedRepositories: v.array(v.string()),
    status: v.union(v.literal("connected"), v.literal("suspended"), v.literal("revoked")),
    connectedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_installation_id", ["installationId"]),
  terminalPresets: defineTable({
    organizationId: v.id("organizations"),
    contextKey: v.string(),
    presets: v.array(v.object({ label: v.string(), objective: v.string() })),
    generatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),
  connectorScheduleRuns: defineTable({
    organizationId: v.id("organizations"),
    scheduleId: v.id("agentSchedules"),
    dueAt: v.number(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("claimed"), v.literal("completed"), v.literal("failed")),
    claimedBy: v.string(),
    leaseExpiresAt: v.number(),
    attempts: v.number(),
    summary: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_schedule", ["scheduleId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),
  growthBaselines: defineTable({
    organizationId: v.id("organizations"),
    activeUsers: v.number(),
    monthlyNewUsers: v.number(),
    monthlyChurnPercent: v.number(),
    monthlyRevenueUsd: v.number(),
    monthlyCostsUsd: v.number(),
    valuationRevenueMultiple: v.number(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_organization", ["organizationId"]),
  growthFeatures: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    status: v.union(v.literal("idea"), v.literal("building"), v.literal("shipped")),
    reachPercent: v.number(),
    adoptionPercent: v.number(),
    monthlyValuePerAdopterUsd: v.number(),
    monthlyRevenuePerAdopterUsd: v.number(),
    retentionLiftPercent: v.number(),
    evidence: v.union(v.literal("hypothesis"), v.literal("interviews"), v.literal("usage"), v.literal("revenue")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),
  growthFeedback: defineTable({
    organizationId: v.id("organizations"),
    featureId: v.optional(v.id("growthFeatures")),
    source: v.string(),
    summary: v.string(),
    kind: v.union(v.literal("problem"), v.literal("request"), v.literal("praise")),
    affectedUsers: v.number(),
    willingnessToPay: v.union(v.literal("unknown"), v.literal("no"), v.literal("maybe"), v.literal("yes")),
    status: v.union(v.literal("new"), v.literal("validated"), v.literal("acted_on")),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"])
    .index("by_feature", ["featureId"]),
});
