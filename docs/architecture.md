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

## Coding-agent orchestration

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
