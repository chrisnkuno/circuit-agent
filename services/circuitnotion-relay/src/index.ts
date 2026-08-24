export interface Env {
  /** Shared secret Convex sends as the x-relay-secret header; set via `wrangler secret put`. */
  RELAY_SHARED_SECRET: string;
}

/**
 * Fixed upstream target. Deliberately not caller-supplied (via a query param, header, or
 * path prefix) — a relay that forwards to an arbitrary destination is an open proxy and an
 * SSRF vector. This Worker exists to change the network egress IP for one specific API, not
 * to be a general-purpose proxy.
 */
const UPSTREAM_ORIGIN = "https://api.circuitnotion.com";

/** True only when the caller presented the exact configured shared secret. */
export function isAuthorized(providedSecret: string | null, expectedSecret: string): boolean {
  return Boolean(expectedSecret) && providedSecret === expectedSecret;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request.headers.get("x-relay-secret"), env.RELAY_SHARED_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }

    const incoming = new URL(request.url);
    const upstreamUrl = `${UPSTREAM_ORIGIN}${incoming.pathname}${incoming.search}`;

    // Cloudflare's documented reverse-proxy idiom: build a new Request against the upstream
    // URL from the original one, which carries over method/headers/body without needing the
    // Node-specific `duplex` workaround (Workers' fetch accepts a streaming body directly).
    const upstreamRequest = new Request(upstreamUrl, request);
    upstreamRequest.headers.delete("x-relay-secret");
    upstreamRequest.headers.set("host", new URL(UPSTREAM_ORIGIN).host);

    return fetch(upstreamRequest);
  },
};
