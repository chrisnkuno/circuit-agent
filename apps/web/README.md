# @circuit-nova/web

The hosted control plane: a Next.js 16 site, a Convex backend, and the durable dispatcher that runs
budgeted, approval-gated agent work in a sandbox.

This is where a task becomes a *priced, authorized, recoverable* run. The agent loop it dispatches
is `@circuit-nova/nova-core`, the same runtime the CLI uses — this app owns the durability, the
money and the authorization around it, not the thinking inside it.

## Layout

| Path | What lives there |
| --- | --- |
| `app/` | Next.js App Router — pages and API routes. |
| `components/` | React components for the workspace UI. |
| `lib/` | The domain: dispatcher planning, budgets, approvals, workers, connectors, artifacts. Plain TypeScript with tests beside it. |
| `convex/` | Schema, queries, mutations, actions and crons. Imports `lib/` for domain logic. |
| `tests/e2e/` | Playwright journeys against a real deployment. |
| `scripts/` | App-specific dev scripts (`bun run wander:once`). |
| `middleware.ts` | The whole-site password gate. |

`convex/` and `lib/` are deliberately coupled and move together: Convex functions are thin, and the
logic they call is in `lib/` where it can be tested without a deployment.

## Running it

From the repository root:

```bash
bun run dev        # this app on localhost:3000
bun run build
bun run test:e2e   # Playwright — needs a real Convex deployment, see below
```

Or from here, with `bun run dev` / `bun run build` / `bun run typecheck`.

## Environment

Copy `.env.example` to `.env.local` in **this directory** — that is where Next looks, and it is the
single env file in the repository; `bun run defender:refresh` at the root reads the same one.

The generated Convex bindings in `convex/_generated` are committed, so `typecheck` and `build` work
on a fresh clone against no deployment at all. After editing `convex/schema.ts` or any
`convex/*.ts` function, regenerate them against your own deployment:

```bash
bunx convex dev --once
```

`bun run test:e2e` is not part of `check` and does not run in CI: it signs up, creates tasks and
asserts persistence against a real Convex deployment, which CI has no credentials for. Run it
locally before merging anything touching the workspace UI or the mutations behind it.

## Deploying

The site is one product in a monorepo, which both platforms need told:

- **Vercel** — set the project's Root Directory to `apps/web`. `.vercelignore` at the repository
  root decides what is uploaded.
- **Netlify** — set the package directory to `apps/web`; the install still happens at the workspace
  root, because `@circuit-nova/nova-core` only resolves from the root lockfile. See `netlify.toml`.

Turning on the relay, the live terminal, Google Calendar or the GitHub App is deployment-only
configuration: [docs/guides/activation.md](../../docs/guides/activation.md).
