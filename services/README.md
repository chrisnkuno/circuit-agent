# services

Independently deployed services. Each one has its own lifecycle, its own deployment config and its
own lockfile, and — unlike `apps/*` and `packages/*` — is **not** a member of the root Bun
workspace. Install and deploy from inside the service's own directory.

| Service | What it does |
| --- | --- |
| [`circuitnotion-relay/`](circuitnotion-relay/) | A Cloudflare Worker reverse proxy that gives model calls a Cloudflare-edge egress path, because CircuitNotion's WAF does not trust Convex Cloud's shared outbound IP range. |

The directory is named for the role, not the vendor. `circuitnotion-relay` is a relay that happens
to run on Cloudflare; if it moved to another platform tomorrow its name would still be right.
