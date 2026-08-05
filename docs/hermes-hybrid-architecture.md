# Circuit Agent × Hermes architecture

This design combines Circuit Agent's durable, task-priced control plane with the strongest architectural patterns from [Nous Research's Hermes Agent](https://github.com/nousresearch/hermes-agent). Hermes is MIT-licensed; this integration currently adapts architectural patterns rather than vendoring its Python runtime or copying implementation files.

## Product shape

Circuit Agent remains the system of record and policy authority. Hermes contributes the model for a multipurpose runtime: a small stable core, capabilities loaded at the edges, reusable skills, multiple interaction surfaces, long-lived memory, scheduled work, and delegation.

```text
Web / mobile / CLI / messaging
              |
      authenticated task intent
              v
Convex control plane
  tenant · quote · budget · approval · run graph · lease · evidence
              |
       capability resolver
  core reasoning + task skills + configured connectors
              |
     isolated execution plane
 E2B coding · browser · data · external connector workers
              |
        artifacts + usage
              v
Convex ledger and human review
```

The model is never the policy authority. It can propose steps and tool calls, but Convex decides whether a task is funded, whether dependencies are complete, whether a capability is configured, and whether an external action has approval.

## What comes from each system

| Keep from Circuit Agent | Adopt from Hermes |
|---|---|
| Organization-scoped authorization | Narrow core with capability at the edges |
| Pre-execution RWF quote and hard cap | Skills and connectors loaded only when relevant |
| Durable dependency graphs and worker leases | Provider-neutral model and runtime selection |
| Per-step reservations and exact usage settlement | Memory-provider and transport boundaries |
| Human gates for overages and consequential actions | Scheduled tasks and delegated subagents |
| E2B isolation, command policy, and evidence | Stable prompt prefixes and bounded context growth |

## Capability model

`lib/capability-registry.ts` is the hybrid system's narrow waist. Every capability declares:

- which task kinds it supports;
- whether it is core, a skill, or a connector;
- its execution runtime;
- its risk class and approval requirement;
- the configuration names required before it is available.

The registry never receives credential values. It reports missing configuration names and rejects unknown capabilities, incompatible task kinds, duplicate identifiers, and external actions without approval.

The first built-in catalogue deliberately stays small:

- core planning, workspace files, and bounded terminal;
- on-demand web research and document composition skills;
- an approval-gated external operations connector boundary.

New capabilities should normally be added as skills or connectors. A new core capability is justified only when nearly every task needs it and an edge capability cannot provide it.

## Multipurpose workflows

`buildTaskPlan` compiles each product task into a distinct graph:

- **Coding:** inspect → reproduce → implement → checks → optional browser verification → review.
- **Research:** scope → source gathering → provenance-aware synthesis → claim review.
- **Writing:** brief → draft → revise → deliverable approval.
- **Operations:** inspect → exact proposal → human approval → external execution → outcome verification.

Capability identifiers are attached to runs and steps and persisted by Convex. This lets the dispatcher eventually route each step to the correct worker without sending every tool definition to every model request.

## Invariants

1. External actions always require explicit approval.
2. Capability availability is checked before provider execution.
3. Credentials stay behind provider adapters and are never included in task prompts or readiness responses.
4. Durable state, cost, approvals, schedules, and memory ownership stay in Convex—not in a local agent process.
5. Sandboxes remain short-lived, workspace-scoped, and evidence-producing.
6. Conversation memory must preserve tenant boundaries, provenance, retention, and user deletion.
7. Skills may guide tool use but cannot widen the command, network, budget, or connector policy.
8. Channels are untrusted interfaces; they submit authenticated intent but do not bypass control-plane checks.

## Runtime architecture extracted from Hermes

### Stable prompt, volatile context

Hermes treats prompt caching as a runtime invariant. Circuit Agent should likewise keep the policy and capability schema byte-stable for the life of a run. Task state, recalled memory, tool output, and user corrections belong in appended messages, not mutations of the stable system prefix. Context compression must create an auditable continuation rather than silently rewriting durable history.

### Bounded tool loop

`BoundedAgentRuntime` implements the narrow runtime waist:

1. heartbeat and cancellation checkpoint;
2. one provider-neutral model turn;
3. cumulative usage and RWF reconciliation;
4. complete preflight of every proposed tool call;
5. approval and capability-scope checks before execution;
6. parallel execution only when every call is explicitly read-only and parallel-safe;
7. bounded tool-result insertion and incremental event persistence;
8. repeat until a verified final answer or an honest terminal limit.

Unknown tools fail closed. External tools are effectful regardless of what their result claims. Tool exceptions become visible results so the model can recover, while provider/accounting failures stop the run.

### Verification is state, not prose

The runtime tracks whether a successful workspace mutation occurred after the latest passing verification command. A model final answer cannot turn that dirty state into success: the result becomes `needs_verification`. Recognized checks currently include Bun/npm scripts, Pytest, Cargo/Go tests, Node's test runner, and `git diff --check`; their actual exit status is the evidence.

### Delegation without authority amplification

Child runs receive a capability subset, a reserved slice of the parent's remaining budget, an independent iteration cap, and explicit depth/concurrency/count limits. They cannot acquire a capability the parent lacks. External-action capability cannot cross the delegation boundary without explicit approval. Child results should return evidence and usage to the parent through durable Convex records rather than in-process handles.

### Durable workspace handoff

The iterative runtime is not yet the default Convex dispatcher path because the present coding graph uses several short-lived step sandboxes. Before migration, one of these continuity models must be implemented:

- a run-scoped E2B sandbox with a renewable lease and guaranteed final cleanup; or
- a Git-backed workspace provisioner where every step checks out the same immutable base plus the prior step's content-addressed patch.

The second model is preferred for recovery: a worker can die, the lease can expire, and another worker can reconstruct the exact workspace without trusting a hibernated process. Repository credentials must be short-lived and removed before model-controlled commands execute.

### Memory and learned skills

Hermes's distinction between small durable facts and larger on-demand procedures is useful, but Circuit Agent must make it tenant-safe:

- memory records require organization ownership, provenance, sensitivity, retention, and deletion state;
- recall results are attached to a run as evidence of influence;
- skill versions are immutable once used by a billed run;
- learned memory and skill changes are staged for review;
- neither memory nor a skill can modify authorization, sandbox, connector, or budget policy.

### Schedules and transports

Scheduling and delivery are separate axes. Convex owns desired schedules, due-job claims, retries, and execution identity. A transport adapter only converts an authenticated message into task intent or delivers a completed artifact; Telegram, Slack, WhatsApp, email, CLI, and web must all exercise the same task, approval, and budget mutations.

## Daily-life multi-app control plane

The multitasker is a workflow compiler over app capabilities, not a second unrestricted agent loop. `ConnectorRegistry` describes provider-neutral actions across calendar, email, files, notes, tasks, messaging, contacts, and home state. Every action declares a permission tier, risk, idempotency behavior, and approval requirement:

- **read** may inspect only the resources and time range granted to the task;
- **draft** may prepare provider-side or task-scoped material but is treated as an external write;
- **execute** covers sends, calendar mutations, sharing, completion, device control, purchases, and deletion.

Non-read actions always require durable approval. A model cannot lower the permission or risk declared by the connector manifest. `authorizeConnectorAction` fails closed for missing, unhealthy, expired, under-scoped, or raw-token connections.

`buildMultiAppWorkflow` turns a daily goal into a dependency graph. Independent reads can run concurrently, while later drafts and sends wait for source evidence and approval. Initial templates cover meeting follow-up, inbox-to-plan, project updates, and an approval-gated evening home routine. A later model-produced structured plan must be revalidated against the connector registry before persistence.

Convex persists four separate concerns:

1. `connectorConnections` contains account labels, granted permission names, health, expiry, and only an opaque `vault://` credential reference.
2. `connectorActionIntents` is the idempotent side-effect boundary linking an exact task, connector, action, risk, input summary, and lifecycle state.
3. `connectorEvents` records connection and action transitions without recording secret values or full private payloads.
4. `agentSchedules` stores paused-by-default workflow schedules and refuses unknown or unconnected connector dependencies.

Only a trusted OAuth or API-key callback may record connection metadata. The web UI cannot mark an account connected. Google Calendar now implements this path with a state-bound, PKCE-protected web-server flow and the narrow `calendar.events.owned` scope. Refresh tokens and event payloads use AES-256-GCM envelopes whose key remains in Convex environment state. Provider access is resolved only inside Node actions; the browser receives sanitized event summaries. See Google's current [web-server OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar scope catalogue](https://developers.google.com/workspace/calendar/api/auth), and [push notification contract](https://developers.google.com/workspace/calendar/api/guides/push).

```text
goal or schedule
  -> validated multi-app workflow
  -> durable action intent + idempotency key
  -> approval when risk is not read
  -> connector worker resolves vault reference
  -> provider adapter performs exact action
  -> sanitized outcome + audit event
```

Retries reuse the same idempotency key. A provider adapter that cannot prove safe idempotency must reconcile remote state before retrying. Sensitive content belongs in encrypted task artifacts or short-lived worker memory, not event messages or model-wide memory.

## Delivery sequence

### Slice 1 — capability-scoped planning (implemented)

- Validated capability registry.
- Distinct coding, research, writing, and operations graphs.
- Capability metadata persisted on Convex runs and steps.
- Operations connector forced through an approval gate.
- UI previews the selected task kind and its actual capabilities.

### Slice 2 — generic tool loop (runtime implemented; dispatcher migration pending)

- Implemented a provider-neutral turn/tool protocol with cumulative usage accounting.
- Implemented bounded iterations, tool-call budgets, tool-result context budgets, cancellation, approval pauses, incremental events, and safe read-only parallelism.
- Implemented CircuitNotion Chat Completions tool calling plus confined E2B read/search/write/command tools.
- Implemented verification tracking: workspace edits cannot finish as completed until a recognized check passes.
- Implemented child delegation policy with capability subsets, budget slices, depth, concurrency, count, and iteration limits.
- Verified the loop live with `gpt-5.6-luna`: six turns, six tools, three files, and two passing Node tests at a calculated 12 RWF.
- Remaining: migrate the Convex dispatcher from the legacy one-shot coding planner, add stable-prefix context compression, and route browser/data steps to dedicated workers.
- Dispatcher migration is gated on durable repository provisioning and cross-step workspace reconstruction.

### Slice 3 — skills and memory

- Store organization-approved skill manifests and versioned instructions.
- Add tenant-scoped episodic and semantic memory with provenance, retention, and deletion.
- Recall only task-relevant memory and record which memories influenced a run.
- Propose learned skills for human review; never allow silent self-modification of policy.

### Slice 4 — schedules, channels, and delegation (control-plane foundation implemented)

- Persisted paused-by-default schedules in Convex; remaining work is idempotent due-job claiming and retry execution.
- Add a transport adapter contract for web, CLI, Telegram, Slack, WhatsApp, and email.
- Use child runs for delegation, with inherited budget slices, capability subsets, depth limits, and parent-visible evidence.
- Deliver results through channels only after tenant authorization and connector policy checks.

### Slice 5 — connector ecosystem (contracts and persistence implemented)

- Implemented opaque external-vault references, revocation metadata, and connection health states; remaining work is the encrypted vault and real OAuth callbacks.
- Implemented read, draft, and execute permission tiers with manifest-enforced risk and approval.
- MCP-compatible connector bridge for reusable external tools.
- Signed/versioned capability packages and evaluation requirements.

## Deliberate non-merges

- Do not place Hermes's unrestricted local terminal inside the trusted web process.
- Do not use SQLite or local files as the production source of truth.
- Do not ship every Hermes tool in the default model schema.
- Do not let autonomous memory or skill learning alter authorization, budgets, or approval policy.
- Do not combine the full Python and TypeScript applications into one deployment unit. Hermes can later be supported as an optional worker runtime behind the same capability contract.
