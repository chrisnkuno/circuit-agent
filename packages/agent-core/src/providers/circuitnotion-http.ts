/**
 * The bits of CircuitNotion access every adapter needs: where it lives, and how to knock.
 *
 * Split out because the agent adapter only needed these two things but imported them from the
 * coding-plan adapter, which pulled the plan schema, the planner prompt and zod behind them. That
 * is invisible in a monorepo and expensive in a published package.
 */

export const CIRCUITNOTION_DEFAULT_BASE_URL = "https://api.circuitnotion.com/v1";

/** Repairs a public API origin setting that omitted the required `/v1` route prefix. */
export function circuitNotionBaseUrl(value?: string): string {
  const candidate = value?.trim() || CIRCUITNOTION_DEFAULT_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.hostname.toLowerCase() === "api.circuitnotion.com" && (url.pathname === "" || url.pathname === "/")) {
      url.pathname = "/v1";
      return url.href.replace(/\/$/, "");
    }
  } catch {
    // Settings validation owns malformed URLs; custom relay routes must remain untouched here.
  }
  return candidate.replace(/\/$/, "");
}

/**
 * Shared default headers for every CircuitNotion call. `relaySecret` is only present when
 * CIRCUITNOTION_BASE_URL points at the CircuitNotion relay Worker (services/circuitnotion-relay)
 * instead of CircuitNotion directly — the Worker rejects any request without this exact header,
 * so it never becomes a general-purpose open proxy for CircuitNotion's API.
 */
export function buildCircuitNotionHeaders(relaySecret?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (relaySecret) headers["x-relay-secret"] = relaySecret;
  return headers;
}
