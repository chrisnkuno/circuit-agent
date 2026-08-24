# Activating the hosted platform

Everything here is deployment-only configuration. Each integration ships disabled and stays
disabled until the environment variables below are set on a Convex deployment — the code is in the
repository, the credentials are not, and nothing in this file changes the behaviour of a local
checkout.

Paths are relative to the repository root; the web app and its Convex backend live in `apps/web/`.

## CircuitNotion relay (Cloudflare Worker)

CircuitNotion's Cloudflare protection blocks Convex Cloud's shared outbound IP range, so a live coding run dispatched through the deployed Convex action used to fail even though the identical call succeeds from a developer machine (see the Model gateway row in [docs/planning/gap-register.md](../planning/gap-register.md)). [services/circuitnotion-relay](../../services/circuitnotion-relay) is a small reverse-proxy Worker, deployed and wired in this environment, that gives the call a different egress path and resolves it; see its own README for deploy steps and how to point `CIRCUITNOTION_BASE_URL`/`CIRCUITNOTION_RELAY_SECRET` at it in another deployment.

## Agent terminal activation

`/terminal` is a real execution surface, not a demo, gated behind two deployment-only environment variables that both default to unset/disabled:

```bash
bunx convex env set ALLOW_TERMINAL_LIVE_EXECUTION true
bunx convex env set ALLOW_DEV_PAYMENT_BYPASS true
```

`ALLOW_DEV_PAYMENT_BYPASS` lets an authenticated organization owner authorize their own task's payment hold without a real Circuit Pay transaction (`apps/web/convex/devPayment.ts`) — this is how the terminal exercises the real dispatcher before Circuit Pay is verified. **Never enable either flag on a deployment reachable by anyone other than trusted developers**: an owner who enables them can authorize a task's cap without a real payment. `run coding <objective>` only executes the plan's `coding`-role steps (inspect, reproduce, implement, checks); the approval-gated review step is intentionally left out of the terminal's live plan because no reviewer-role worker exists yet.

## Google Calendar activation

Create a Google OAuth **Web application** client, enable the Calendar API, and register the exact callback shown by `GOOGLE_OAUTH_REDIRECT_URI`. Then set the two remaining server-only values on the Convex deployment:

```bash
bunx convex env set GOOGLE_OAUTH_CLIENT_ID
bunx convex env set GOOGLE_OAUTH_CLIENT_SECRET
bunx convex dev --once
```

The connector requests only `calendar.events.owned`, offline access, state, and PKCE. The client secret and vault key are Convex environment variables; OAuth and action payloads are encrypted before database insertion and never sent to the browser.

## GitHub App activation

Create a GitHub App with a **Setup URL** of `NEXT_PUBLIC_SITE_URL` + `/api/connectors/github/callback` and a **Webhook URL** of the Convex site URL + `/github/webhook`, subscribed to the `installation` and `installation_repositories` events. Then set the server-only values on the Convex deployment:

```bash
bunx convex env set GITHUB_APP_ID
bunx convex env set GITHUB_APP_SLUG
bunx convex env set GITHUB_APP_PRIVATE_KEY
bunx convex env set GITHUB_WEBHOOK_SECRET
bunx convex dev --once
```

Installation identity is never trusted from the browser redirect: the callback only carries a state-bound installation ID, which the server re-resolves against GitHub using the App's own JWT before recording anything. The App private key never leaves Convex environment state, and every repository action mints a fresh, short-lived installation token rather than persisting one.

