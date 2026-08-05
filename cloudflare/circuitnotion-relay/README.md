# circuitnotion-relay

A minimal Cloudflare Worker that reverse-proxies to `https://api.circuitnotion.com`, unmodified except for one stripped/added header. It exists for exactly one reason: CircuitNotion's Cloudflare bot-protection currently challenges Convex Cloud's shared outbound IP range, even though the identical request from an ordinary developer machine succeeds. Routing through this Worker gives the call a different (Cloudflare) egress path.

It is **not** a general-purpose proxy: the upstream host is hardcoded (`src/index.ts`), and every request must carry an `x-relay-secret` header matching the Worker's own `RELAY_SHARED_SECRET`, or it gets a `403`. Nothing about the request is otherwise altered — the real `CIRCUITNOTION_API_KEY` still flows through from Convex to CircuitNotion exactly as it does today.

## Deploy

```bash
cd cloudflare/circuitnotion-relay
bun install
bunx wrangler login          # opens a browser; needs a Cloudflare account
bunx wrangler secret put RELAY_SHARED_SECRET   # paste a long random value when prompted
bun run deploy
```

`wrangler deploy` prints the Worker's URL, something like `https://circuitnotion-relay.<your-subdomain>.workers.dev`.

## Wire it into Circuit-Nova

Set these on the Convex deployment (not `.env.local` — this is read server-side by the Convex action, same as `CIRCUITNOTION_API_KEY`):

```bash
bunx convex env set CIRCUITNOTION_BASE_URL https://circuitnotion-relay.<your-subdomain>.workers.dev/v1
bunx convex env set CIRCUITNOTION_RELAY_SECRET <the same value you gave RELAY_SHARED_SECRET>
```

Both `lib/providers/circuitnotion.ts` and `lib/providers/circuitnotion-agent.ts` read `relaySecret` and add the `x-relay-secret` header automatically whenever it's set — no other code changes needed. Unset `CIRCUITNOTION_BASE_URL` (or point it back at `https://api.circuitnotion.com/v1`) to bypass the relay entirely.

## Local development

```bash
bun run dev        # wrangler dev; runs the Worker locally against real CircuitNotion
bun test            # 3 tests for the auth-check logic
bun run typecheck
```

## Why a secret header instead of trusting any caller

Without it, this Worker would be a free, anonymous relay to CircuitNotion's API for anyone who discovers the `.workers.dev` URL — they'd supply their own `Authorization` header, so it wouldn't leak *our* API key, but it's still infrastructure abuse we don't want to host. The secret check makes the Worker useless to anyone except this deployment.
