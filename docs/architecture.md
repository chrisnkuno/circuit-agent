# Circuit Agent foundation

## System boundaries

Circuit Agent is organized around four independent concerns:

1. **Interface layer** — responsive web, native mobile, and future desktop clients create tasks, observe progress, and approve sensitive work.
2. **Control plane** — Convex owns durable tasks, quotes, task events, payment-hold state, permissions, and future workflow scheduling.
3. **Execution plane** — E2B sandboxes execute code, browser, and data work outside the user device and outside the Convex database runtime.
4. **Provider adapters** — Circuit Pay and E2B credentials and APIs live behind narrow contracts in `lib/providers/`.

Organization membership is the backend trust boundary. User-callable task, run, cancellation, and approval functions resolve the authenticated identity to an active organization role. Worker claim, settlement, and lease-recovery functions are internal-only.

## Task lifecycle

```text
draft -> quoted -> awaiting_approval -> running -> completed
                                    \-> blocked
```

`createQuotedTask` atomically records the task, quote, pending payment hold, and a quote-created event. It accepts an organization-scoped idempotency key so a mobile reconnect cannot accidentally create a duplicate hold. Additional mutations create and cancel coding runs, decide approvals, claim leased work internally, record usage and evidence, and recover expired leases.

Convex generated bindings are a deployment-scoped artifact and will be created by `bunx convex dev` when the deployment is configured. Until then, the backend module stays isolated from the frontend build; it is not represented as a running backend.

## Pricing rule

The v1 estimator is transparent and deterministic. It calculates expected execution cost from task type, quality tier, attachment count, sandbox use, and browser use; then adds an uncertainty reserve and a rounded hard cap. It is intentionally not presented as an exact provider price.

Later, historical actuals will calibrate the quote, but the public quote contract remains:

```text
low estimate <= high estimate <= approved maximum
```

No task may charge above `approved maximum` without a new approval.

## Multipurpose orchestration

The control plane uses a narrow capability registry inspired by Hermes Agent's extension architecture. Core capabilities stay small; task-specific skills and configured connectors are selected only for the current task. Capability manifests declare supported task kinds, runtime, risk, approval requirements, and configuration gates without containing credential values.

`buildTaskPlan` compiles coding, research, writing, and operations work into different dependency graphs. Runs and steps carry their capability identifiers into Convex so future dispatchers can route them to coding, browser, data, or connector workers. Any capability classified as an external action must sit behind a human approval step.

See [hermes-hybrid-architecture.md](hermes-hybrid-architecture.md) for the full architecture and delivery sequence.

## Coding-agent execution

`lib/agent-orchestration.ts` creates an immutable, dependency-aware coding plan: inspect, reproduce, implement, verify, optional browser verification, and review handoff. The scheduler releases only dependency-free steps and obeys an explicit per-run parallelism cap.

Convex persists this plan across `agentRuns`, `agentSteps`, and `agentRunEvents`. A provider worker must change step state and save evidence; it cannot merge, deploy, send, or exceed the spending cap.

Each running step owns its RWF reservation and a time-bounded worker lease. Completion settles that exact reservation. Expired leases release it before retrying, and repeated expiry becomes a truthful failed state.

`planDispatch` combines validated run graphs, fair global scheduling, provider readiness, approval gates, and per-run budgets into an explicit decision before any worker is called. Convex exposes an internal-only dispatch snapshot and runs lease recovery every minute once the deployment is activated.

`CodingAgentWorker` is the credential-independent execution engine behind a future Convex Node action. It asks the OpenAI Responses API adapter for a schema-validated plan, writes only workspace-scoped files, executes argv commands through a defense-in-depth policy, heartbeats between operations, checks cancellation, captures content-addressed evidence, and stops E2B in a `finally` block.

The model prompt is versioned in code with typed inputs and representative tests, following current OpenAI guidance for [code-managed production prompts](https://developers.openai.com/api/docs/guides/text#version-prompts-in-code). Coding plans use [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and the configured model remains explicit rather than silently following an alias.

Preflight model pricing has two values: an expected token estimate and a conservative byte-based reservation cap. Actual input, output, cached, cache-write, and reasoning token usage is recorded from the provider response and converted using versioned RWF-per-million-token configuration.

## Provider activation gates

- Circuit Pay integration requires verified API authentication, payment-hold/checkout semantics, webhook signing, refunds, and idempotency behavior.
- E2B integration requires an API key, approved templates, short-lived scoped credentials, output retention policy, and usage reconciliation.
- OpenAI integration requires an API key, explicit model, and versioned input/output RWF rates. Missing usage accounting or a malformed/refused response fails closed.
- The current UI labels those integrations as blocked rather than pretending a reservation or execution occurred.
- `/api/health` reports control-plane, coding, and payment readiness using configuration presence only; it never returns credential values.

## Multi-app connections

The multi-app layer uses a provider-neutral connector registry and a durable action-intent boundary. Google Calendar, Gmail, Drive, Notion, Todoist, Slack, WhatsApp Business, and Home Assistant currently have validated manifests, but no provider is represented as connected without a trusted callback and an opaque credential-vault reference.

Convex stores connection metadata, permission names, expiry, paused schedules, approval-linked action intents, and sanitized audit events. Google Calendar is the first concrete adapter: state + PKCE OAuth with the narrow `calendar.events.owned` scope, AES-256-GCM token and payload encryption, offline refresh, provider revocation, bounded reads, approval-gated event insertion, push-channel verification, and leased daily-digest claims. The development schema/functions and cron are deployed; a live consent/read/write proof awaits a configured Google OAuth client.

Google push notifications are accepted only when channel ID, opaque resource ID, hashed channel token, increasing message number, channel status, and expiration all validate. Notifications contain no event body; the trusted worker performs the subsequent scoped read. Scheduled occurrences use one durable idempotency key per schedule and due timestamp, a two-minute lease, and an explicit completed/failed record.
