# Technical assessment

## Assessment record

| Field | Value |
|---|---|
| Assessment date | 2026-07-26 |
| Scope | Current local repository only |
| Evidence reviewed | Domain logic, tests, interface, Convex schema/functions, provider contracts, architecture documentation |
| Verification observed | 63 domain/worker/adapter tests, 96.86% function coverage, 99.59% line coverage, typecheck, production build, and 7 passing Playwright checks across desktop and mobile viewports |
| Production verification | Not performed; Convex, E2B, Circuit Pay, model, and connector integrations are inactive |

This is a repository-grounded maturity assessment, not a security certification, penetration test, provider review, or production-readiness approval.

## Executive finding

Circuit-Nova is a coherent, tested foundation for a task-priced agent platform. It is not yet a complete or production-ready agent system. The strongest implemented seams are transparent RWF quoting, dependency-aware task planning, bounded scheduling, durable data models, and explicit provider contracts. The weakest seams are live execution, identity/security, provider integrations, mobile delivery, and production operations.

**Current technical maturity: 68 / 100 — integrated, locally tested pre-alpha execution engine.**

## Scoring method

The score weights capabilities by their importance to a trustworthy end-to-end outcome. A written interface or schema earns partial credit; a locally tested implementation earns more; deployed behavior with failure recovery and operational evidence earns full credit.

| Area | Weight | Current score | Weighted contribution |
|---|---:|---:|---:|
| Domain model and orchestration correctness | 20% | 89 | 17.8 |
| Durable control plane and recovery | 15% | 70 | 10.5 |
| Coding execution and evidence | 15% | 68 | 10.2 |
| Cost control and payment integrity | 15% | 66 | 9.9 |
| Identity, permissions, and security | 15% | 48 | 7.2 |
| Interfaces and mobile supervision | 10% | 58 | 5.8 |
| Operations, evaluation, and observability | 10% | 65 | 6.5 |
| **Total** | **100%** |  | **68 / 100** |

Scores should change only when evidence changes. Documentation alone does not increase the system maturity score.

## Capability scorecard

| Capability | Score | Evidence | Missing before production |
|---|---:|---|---|
| Product/domain model | 8/10 | Tasks, quotes, payment holds, runs, steps, approvals, usage ledger | Versioned public API and migration policy |
| Cost control | 8/10 | Quote/cap enforcement, conservative token reservation, explicit RWF rates, actual token reconciliation, and idempotent settlement | Live price/FX catalog, calibration, sandbox metering, and payment reconciliation |
| Orchestration | 8/10 | DAG validation, fair dispatch, approval records, cancellation checkpoints, heartbeats, retries, and lease recovery | Deployed dispatcher action, backpressure, and killed-worker integration tests |
| Coding-agent workflow | 7/10 | Structured OpenAI planning, scoped file writes, command policy, E2B execution loop, evidence capture, and forced cleanup | GitHub authorization, live template, durable artifact blob storage, patch/PR path |
| Persistence | 7/10 | Organization-scoped Convex schema, approvals, heartbeats, sandbox IDs, artifact metadata, leases, and usage ledger | Convex deployment, generated bindings, backend tests, migrations, and backup validation |
| Interface | 6/10 | Responsive quote builder, transparent orchestration preview, and browser workflow checks | Authenticated operational workspace, task detail, approvals, artifacts |
| Mobile | 3/10 | Responsive web behavior and automated no-overflow mobile viewport check | Native app, push, biometrics, deep links, offline/reconnect testing |
| App connectors | 1/10 | Provider boundaries only | OAuth vault and first real GitHub/Google/Slack connectors |
| Security | 5/10 | Organization roles, internal worker boundary, workspace/file/command policy, non-stored model requests, safety identifiers, negative tests | Auth provider, secret manager, webhook verification, threat model, deployed tenant tests |
| Operations | 7/10 | 63 tests, high core coverage, worker failure/cancellation tests, readiness diagnostics, Playwright, typecheck and production build | Alerts, tracing, SLOs, live provider probes, incident and recovery procedures |

## Implemented architecture

```text
Responsive interface
  -> quote and task-plan domain functions
  -> Convex durable control-plane model
  -> budget guard + approvals + usage ledger
  -> secure E2B adapter + provider contracts
  -> future model / Circuit Pay / app adapters
```

The architecture correctly separates durable intent from external side effects. Payment authorization, sandbox execution, and app actions are not falsely represented as live.

## Non-negotiable system invariants

These rules should be encoded in tests and backend authorization, not left as interface promises:

1. No sandbox or external side effect starts without a persisted task and step identity.
2. No task spends above its approved RWF cap without a new, recorded approval.
3. Provider usage is idempotent and reconciles to exactly one ledger record.
4. A completed step includes evidence or explicitly declares that no artifact is expected.
5. A worker may mutate only the step covered by its valid lease.
6. Cancelling a run prevents new work and active workers stop at safe checkpoints.
7. Client-visible roles never grant backend authority; organization membership and policy are checked server-side.
8. Missing configuration, expired credentials, and uncertain outcomes remain explicit terminal or recoverable states.

## Features added in this assessment

- Graph validation rejects duplicate IDs, missing dependencies, and cycles.
- Scheduling is fair across multiple runs and respects both per-run and global concurrency.
- Failed or cancelled parent steps propagate honest blocked states.
- Integer-RWF budget reservations and settlements prevent silent cap overruns.
- Convex now models worker claims, leases, attempts, cancellation, approvals, artifacts, and an idempotent usage ledger.
- Provider completion requires evidence references and a worker-owned lease.
- Organization roles and backend permission checks now protect user-callable task, run, cancellation, and approval operations.
- Worker claims and outcomes are internal-only, while step-scoped RWF reservations reconcile exact usage.
- Expired worker leases release reservations, retry below the ceiling, and fail honestly at the ceiling.
- Provider readiness is reported without exposing secret values through `/api/health`.
- Dispatch decisions now combine provider readiness, approval gates, budgets, global capacity, and globally unique step ownership.
- Convex validates planner graphs before persistence and closes a run only after all of its steps complete.
- Worker outcome recording rejects expired or foreign leases, negative usage, usage above the step reservation, and completion after cancellation.
- A concrete E2B adapter defaults to secure access, approved templates, bounded runtime, an argv-safe command allowlist, disabled internet, and explicit termination.
- Playwright verifies the current quote and multi-run workflows across desktop and mobile viewports.
- OpenAI Responses API planning uses a code-versioned prompt, Zod-backed Structured Output, explicit refusals, bounded output, timeout signals, `store: false`, safety identifiers, and token usage capture.
- Model calls now have expected and conservative maximum token/RWF estimates, with actual usage reconciliation.
- The coding worker composes model planning, workspace-scoped file writes, approved argv commands, cancellation checkpoints, heartbeats, patch/log evidence, and guaranteed E2B termination.
- Convex now creates real approval rows for approval-gated steps, persists heartbeat/sandbox/artifact metadata, exposes authorized run detail, and rejects usage or artifact idempotency collisions.
- Task and quote lifecycle validation now rejects malformed quote ranges, conflicting idempotent replays, claims on non-dispatchable runs, and inconsistent task terminal states.

## Critical missing systems

### 1. Identity and authorization

The organization, membership, role matrix, and backend authorization helpers now exist. A real authentication provider, session bridge, bootstrap flow, deployed negative authorization tests, and secret-management system are still missing. These block any real repository, payment, or app connection.

### 2. Live worker runtime

A pure dispatcher, coding-worker engine, heartbeat mutation, and scheduled lease recovery exist, but no deployed Convex Node action currently claims work and invokes them. Live backpressure, credential injection, provider idempotency integration, and killed-worker recovery remain unverified.

### 3. Real coding execution

The coding workflow, OpenAI planning adapter, E2B transport, and evidence engine are defined and locally composed. The system still cannot clone an authorized repository, make a live model/sandbox call, persist artifact blobs, stream live logs, or open a PR. GitHub remains the first complete connector.

### 4. Payment activation

Circuit Pay’s verified API contract, signed webhooks, authorization/capture/refund semantics, reconciliation, and dispute handling are not implemented. The existing payment state is a safe domain boundary, not a live rail.

### 5. Production control plane

Convex is not configured or deployed. Generated types are therefore absent and backend functions are not part of the current frontend typecheck. This must be closed before calling persistence real.

### 6. Evaluation and safety

There is no task-quality evaluation suite, prompt-injection defense, connector data-loss prevention, repository policy file, malware/file scanning, or red-team corpus.

## Prioritized risk register

| Priority | Risk | Likelihood | Impact | Required mitigation | Closure evidence |
|---|---|---:|---:|---|---|
| P0 | Cross-tenant data or credential access | Medium | Critical | Authentication, organization scoping, RBAC helpers, secret vault | Negative authorization tests across every public function |
| P0 | Duplicate charge or silent overcharge | Medium | Critical | Signed webhooks, idempotency, atomic ledger, reconciliation jobs | Replay tests and provider-to-ledger reconciliation |
| P0 | Untrusted code escapes execution boundary | Low–medium | Critical | E2B isolation, scoped credentials, egress policy, command policy | Sandbox escape review and credential-access tests |
| P0 | Worker dies after an external side effect | High | High | Leases, idempotent provider operations, reconciliation state | Kill-and-resume integration test |
| P1 | Prompt injection triggers unauthorized app action | High | High | Permission manifest, content/tool separation, action preview | Adversarial connector evaluation suite |
| P1 | Quote materially underestimates real task cost | High initially | Medium | Conservative P90 cap, staged tasks, live usage stop | Quote error distribution over completed tasks |
| P1 | Cancellation appears successful while work continues | Medium | High | Heartbeats, cancellation checkpoints, sandbox termination | Cancel-during-execution test with provider confirmation |
| P2 | Mobile reconnect duplicates task or approval | Medium | Medium | Client idempotency keys and durable mutation results | Offline/reconnect automated tests |

## Verification and acceptance matrix

| Layer | Current evidence | Required next test | Private-beta gate |
|---|---|---|---|
| Quote engine | Unit-tested integer-RWF range and cap | Provider-price fixtures and FX expiry | P90 quote error tracked and no cap bypass |
| Task graph | DAG, fairness, failure, and budget tests | Property-based graph and concurrency tests | No cycle/deadlock across evaluation corpus |
| Convex control plane | Tenant model, permission helpers, internal worker boundary, recovery mutations written | Generated-type, auth-provider, authorization, and `convex-test` suite | Deployed dev/preview/prod with recovery tests |
| OpenAI model | Structured adapter, refusal handling, token/RWF accounting, and fake-provider tests | Live plan, timeout, refusal, and usage reconciliation | Evaluation-routed model completes representative plans within cap |
| E2B worker | Secure adapter and composed file/edit/test/evidence worker tested with fakes | Real clone/edit/test/cancel/timeout integration | Killed worker resumes without duplicate side effect |
| GitHub | Not implemented | App install, repo scope, patch and PR tests | Approval-gated PR created from tested artifact |
| Circuit Pay | State model only | Signed webhook replay and reconciliation tests | Hold/capture/release/refund balances reconcile |
| Mobile | Responsive browser build and mobile viewport workflow test | Native background, push, deep-link, offline tests | Full task supervision without desktop |
| Security | Approval concepts only | Threat model, tenant isolation, secret and injection tests | P0 findings closed or formally accepted |

## Dependency order

```text
Authentication + organizations
  -> Convex activation and authorization helpers
    -> secret vault + GitHub App
      -> model gateway + E2B dispatcher
        -> evidence and approval workflow
          -> usage reconciliation + Circuit Pay
            -> native mobile supervision
```

Attempting live execution before the first three dependencies would create an unsafe credential and tenancy model.

## Technical completion criteria

The system becomes a credible private beta when one authenticated user can authorize a GitHub repository, receive a real RWF quote, approve a payment hold, run a coding task in E2B, watch durable progress from another device, receive tested artifacts, approve a PR, and reconcile actual cost—all with an auditable trail and recovery from a killed worker.

### Quantitative private-beta gates

- 100% of public Convex functions enforce authenticated organization scope.
- Zero duplicate ledger entries across webhook and worker replay tests.
- 95% of eligible coding tasks reach a truthful terminal state without operator database repair.
- 100% of completed coding steps include logs, test evidence, a patch, or an explicit no-artifact reason.
- Cancellation stops new work immediately and terminates active sandboxes within the defined operational timeout.
- P95 task-state propagation reaches connected clients within the product SLO selected during Phase 0.
- No unresolved P0 security or payment-integrity risk enters private beta.

## Assessment limitations

- Convex functions are excluded from the frontend TypeScript build until deployment bindings exist.
- `bunx convex codegen --typecheck enable` was attempted and correctly remained blocked because `CONVEX_DEPLOYMENT` is not configured.
- Browser workflows and mobile viewport geometry were tested; visual regression and native mobile behavior were not.
- No external provider credentials, webhooks, pricing responses, or production data were exercised.
- Scores should be revisited after every phase exit gate, not on a calendar-only cadence.
