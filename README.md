# Circuit Agent

An early foundation for a task-priced, multi-interface AI agent system.

Users should know a task's expected RWF cost and maximum approved spend before an agent executes it. Convex persists the durable work state; E2B is the intended isolated execution layer; Circuit Pay is the intended billing adapter.

## Current implementation

- Responsive task quote interface with RWF estimate, confidence, assumptions, and hard cap.
- Pure typed v1 task-cost estimator with tests.
- Convex schema for tasks, quotes, payment holds, and immutable task events.
- Idempotent `createQuotedTask` mutation, ready to be called after client authentication is wired.
- Explicit provider contracts for Circuit Pay and E2B.
- Dependency-graph validation, fair multi-run scheduling, failure propagation, and cancellation states.
- Integer-RWF task budget enforcement with reservation and settlement tests.
- Durable worker leases, approval requests, evidence references, and idempotent usage records in the Convex model.
- Organization-scoped roles and backend authorization boundaries.
- Step-scoped RWF reservations with expired-lease release and retry policy.
- Auditable dispatcher planning that combines graph validity, fair global scheduling, provider readiness, approvals, and budgets.
- Concrete E2B adapter with secure access, approved-template gating, bounded runtime, command allowlisting, opt-in internet, and sandbox termination.
- OpenAI Responses API coding planner with code-versioned prompts, Structured Outputs, explicit model selection, non-stored responses, and complete token accounting.
- Conservative token-to-RWF model reservation plus reconciliation from actual provider usage.
- Bounded coding worker that writes scoped files, runs checks, observes cancellation checkpoints, captures content-addressed evidence, and terminates E2B in every exit path.
- Convex heartbeat, sandbox identity, artifact metadata, approval records, and lifecycle transitions ready for deployment validation.
- Minute-based expired-lease recovery cron ready to activate with Convex.
- Secret-safe provider readiness diagnostics at `/api/health`.
- Desktop and mobile-viewport Playwright coverage for the current operational interface.

## Deliberately not yet activated

No live payment, sandbox, connector, or model call is made. Those integrations require provider credentials and verified API contracts. The interface states this truthfully.

## Development

```bash
bun install
bun run dev
bun test
bun run typecheck
bun run build
bun run test:e2e
```

To activate Convex, configure a deployment then generate its bindings before deployment:

```bash
bunx convex dev
```

`convex/_generated` is intentionally absent until a Convex deployment is configured. The frontend and pure pricing logic can be verified before that activation; the Convex backend should be typechecked immediately after code generation.

## System map

See [docs/architecture.md](docs/architecture.md) for boundaries, lifecycle, pricing invariant, and provider activation gates.

The current system is assessed in [docs/assessment-technical.md](docs/assessment-technical.md). The philosophical direction and staged delivery plan are in [docs/assessment-roadmap.md](docs/assessment-roadmap.md).

The actionable, evidence-based backlog is tracked in [docs/gap-register.md](docs/gap-register.md).
