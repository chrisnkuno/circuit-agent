# Philosophy and roadmap assessment

## Strategic thesis

Circuit-Nova’s initial customer is a mobile-first professional, founder, or small technical team that has meaningful work to complete but cannot continuously supervise an AI session. The first wedge is repository work because coding forces the product to prove permissions, isolation, long-running execution, verification, artifacts, cost control, and human approval in one workflow.

The product promise is:

> Give Circuit-Nova an outcome, approve a clear RWF cap, leave the interface, and return to evidence-backed work you can inspect and control.

This is narrower and more defensible than “an agent that can do everything.” Everyday app workflows should inherit the proven execution contract rather than invent a second system.

## Philosophical direction

Circuit-Nova should be built around **legible autonomy**: the machine may act independently inside a boundary that the person can understand, price, interrupt, and audit.

Five principles define the product:

1. **Outcomes over tokens.** People buy a bounded piece of work in RWF, not an abstract quantity of model consumption.
2. **Human authority over machine initiative.** The agent can plan and execute reversible work; consequential actions cross a visible approval gate.
3. **Evidence over performance.** “Completed” means tests, artifacts, provider receipts, or observable application state—not a persuasive model message.
4. **Durability over spectacle.** A task must survive a closed phone, a failed worker, and a provider outage. Animated agent activity is secondary.
5. **Graceful limits over fabricated success.** Missing credentials, uncertain scope, exhausted budgets, and unsafe requests become explicit states.

This direction positions Circuit-Nova as a trusted execution layer for individuals and teams, with coding as the first demanding proof of reliability.

## Product boundaries and non-goals

Until the coding vertical passes its exit gate, Circuit-Nova is not trying to be:

- An unconstrained autonomous employee.
- A social collection of agent personalities.
- A general connector marketplace.
- A replacement for repository owners, payment authorization, or organizational policy.
- A token wallet whose economics are disconnected from outcomes.
- A dashboard that implies execution when providers are not configured.

These boundaries protect focus and keep the trust surface proportional to proven capability.

## Product assessment

The system currently expresses the philosophy well in its architecture, but not yet through a complete outcome. The next goal should not be “more kinds of agents.” It should be one excellent end-to-end coding task that proves quoting, persistence, execution, evidence, payment, and mobile supervision.

## Roadmap

### Phase 0 — Foundation closure

**Goal:** make the current control plane real.

- Configure development, preview, and production Convex deployments.
- Add authentication, organizations, membership roles, and backend authorization helpers.
- Generate and typecheck Convex bindings in CI.
- Connect the implemented dispatcher, coding worker, heartbeat, cancellation, artifact, and lease-recovery contracts to deployed Convex actions.
- Establish structured logs, tracing IDs, error reporting, and environment validation.

**Exit gate:** a durable synthetic task survives worker termination and resumes without duplicate execution or overspend.

### Phase 1 — Complete coding-agent vertical

**Goal:** deliver one paid, evidence-backed coding outcome.

- GitHub App installation and per-repository permissions.
- Extend the implemented model gateway with evaluation-backed fast/balanced/expert routing.
- E2B coding template, authorized repository clone, worktree, durable artifact storage, and live cleanup validation.
- Patch review, test evidence, browser screenshots, and approval-gated PR creation.
- Quote calibration from actual token, sandbox, and connector usage.

**Exit gate:** issue to tested PR works repeatedly across representative TypeScript and Python repositories.

### Phase 2 — Mobile command and supervision

**Goal:** make complex cloud work genuinely operable from a phone.

- Expo application sharing the typed task and approval contracts.
- Voice task entry, file/share-sheet ingestion, push notifications, and deep-linked approvals.
- Biometric confirmation for sensitive actions.
- Offline-safe task creation and reconnect behavior.
- Compact diff, evidence, cost, and blocker views.

**Exit gate:** a user starts a coding task, closes the app, receives a blocker/approval push, and completes the PR workflow without desktop access.

### Phase 3 — Everyday work connectors

**Goal:** extend the same execution contract beyond code.

- Google and Microsoft mail/calendar/drive.
- Slack/Teams, Notion, Linear/Jira, then CRM.
- OAuth token vault, permission manifest, revocation, and connector health.
- Reusable workflows: meeting preparation, inbox triage, research brief, document delivery.

**Exit gate:** every connector has read/draft/execute permission tiers, evidence, idempotency, and revocation tests.

### Phase 4 — Circuit Pay and task marketplace economics

**Goal:** turn bounded execution into a sustainable RWF product.

- Verify and implement Circuit Pay checkout/authorization, signed webhooks, capture, release, refund, and reconciliation.
- Fixed, capped, and staged task pricing.
- FX validity windows, provider cost catalog, platform margin, receipts, and disputes.
- Historical P50/P90 estimator calibration and quote-accuracy reporting.

**Exit gate:** the payment ledger reconciles holds, actual usage, captures, and refunds with no silent overcharge.

### Phase 5 — Platform and ecosystem

**Goal:** safely support third-party workflows and specialist agents.

- Versioned connector/agent SDK and permission manifests.
- Organization policies, SSO, retention, audit export, and regional data controls.
- Agent evaluations, signed templates, marketplace review, and revenue sharing.
- Multi-agent optimization only after end-to-end reliability is measurable.

## Roadmap priorities

The next three implementation milestones should be:

1. Convex activation plus authentication and deployed authorization tests.
2. Real GitHub repository provisioning connected to the implemented OpenAI + E2B coding worker.
3. Deploy provider usage and artifact reconciliation through Convex, followed by verified Circuit Pay reconciliation.

Do not prioritize additional visual agent personalities, autonomous email sending, a broad connector catalogue, or a marketplace before those milestones. They expand the trust surface without proving the core system.

## Critical path

```text
Identity and tenancy
  -> deployed Convex control plane
    -> secrets and GitHub authorization
      -> model gateway and E2B worker
        -> evidence + approval UX
          -> metering and Circuit Pay reconciliation
            -> native mobile supervision
```

Mobile interface work can begin in parallel once shared task and approval contracts stabilize, but mobile release cannot precede durable state, push-safe idempotency, and approval authorization.

## First 90-day execution plan

### Days 1–30 — Trust foundation

- Configure separate Convex environments and generated-type CI.
- Implement authentication, organizations, memberships, and authorization tests.
- Establish secret storage, environment validation, structured logs, trace IDs, and error reporting.
- Implement dispatcher leases, heartbeat, cancellation, reaping, and replay-safe usage accounting.

**Demonstration:** an authenticated synthetic run survives a killed worker and preserves budget and audit state.

### Days 31–60 — Real coding loop

- Install and authorize the GitHub App against selected repositories.
- Build the E2B coding template and worker dispatcher.
- Add model routing, usage capture, repository inspection, patch generation, tests, and artifact storage.
- Implement operator-visible logs, blockers, retry controls, and approval-gated PR creation.

**Demonstration:** a real issue becomes a tested patch and approved PR with a complete evidence trail.

### Days 61–90 — Economics and mobile supervision

- Calibrate task quotes from real model, sandbox, and connector usage.
- Integrate verified Circuit Pay authorization and reconciliation if its API contract satisfies the payment gates.
- Build the first Expo task timeline, push approval, deep link, and biometric confirmation flow.
- Run adversarial, cancellation, reconnect, tenant-isolation, and payment-replay evaluations.

**Demonstration:** a phone-initiated paid task completes through PR approval and cost settlement after the app has been closed and reopened.

## Product and reliability metrics

| Objective | Primary metric | Guardrail |
|---|---|---|
| Deliver outcomes | Eligible task completion rate | Truthful blocked/failed states are not counted as success |
| Earn cost trust | Absolute quote error and cap-overrun count | Zero unapproved overruns |
| Reduce supervision | Human interventions per completed task | Consequential approvals remain mandatory |
| Prove quality | Test/evidence pass rate and accepted PR rate | Never suppress failed checks |
| Make mobile useful | Phone-started tasks completed without desktop | No approval through notification text alone |
| Operate reliably | Recovery rate after worker/provider failure | No duplicate side effect or charge |
| Protect users | P0/P1 security findings and tenant-isolation failures | P0 blocks release |

## Workstreams and ownership

The roadmap needs five accountable workstreams even if one small team covers several:

1. **Control plane:** Convex, auth, tenancy, workflows, leases, audit, and policy.
2. **Execution:** model gateway, E2B templates, coding tools, artifacts, and evaluations.
3. **Experience:** web workspace, mobile app, approvals, notifications, and accessibility.
4. **Economics:** estimator, usage ledger, Circuit Pay, reconciliation, and support operations.
5. **Trust:** threat model, secrets, connector permissions, observability, incidents, and compliance readiness.

Each phase should name one owner per exit gate and attach links to test evidence. Feature completion without an owner for operations and failure recovery is incomplete.

## Decision gates

- **Proceed from Phase 0** only when worker replay, tenant isolation, and cancellation pass automated tests.
- **Proceed from Phase 1** only when representative repositories produce repeatable tested PRs with complete evidence.
- **Activate payments** only after signed webhook, idempotency, reconciliation, refund, and dispute behavior are verified against Circuit Pay’s real contract.
- **Expand connectors** only when GitHub permission revocation and credential rotation work end to end.
- **Open an agent marketplace** only after permission manifests, evaluations, signing, review, and incident removal processes exist.

If an exit gate fails repeatedly, reduce scope or strengthen the platform; do not conceal the failure with a broader demo.
