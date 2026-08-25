import { hostOf } from "./endpoints";

/**
 * Turns raw fetch/undici/SDK errors into one actionable sentence.
 *
 * The CLI used to print whatever the transport threw — `error fetch failed`, `getaddrinfo
 * ENOTFOUND api.circuitnotion.com`, `The operation was aborted` — which reads as "internet is
 * broken" and tells the user nothing about which endpoint failed, why, or what to do about it.
 * This classifier owns that translation so every network surface (the turn loop, the FX lookup,
 * the update check, `nova --doctor`) reports the same way.
 *
 * A non-network error (a schema failure, a budget refusal, a tool error) returns null and the
 * caller falls back to the raw message, so this never rewrites errors that have nothing to do
 * with the network.
 */

export type NetworkErrorKind =
  | "timeout" | "dns" | "refused" | "reset" | "unreachable" | "tls" | "aborted"
  | "not_found" | "authentication" | "permission" | "rate_limit" | "bad_request" | "server_error";

export type NetworkDiagnosis = {
  kind: NetworkErrorKind;
  /** One sentence naming the host and what happened, for direct display. */
  message: string;
  /** The concrete next step, when one exists. */
  hint?: string;
};

export type ClassifyOptions = {
  /** Host the call was trying to reach, when known. */
  host?: string;
  /** What the call was for, e.g. "the model API". */
  purpose?: string;
  /** Runtime retry context, normally inferred from ProviderRequestError. */
  attempts?: number;
  /** Why a safe automatic retry was not attempted. */
  retrySuppressed?: "output_started" | null;
};

/** Error codes the transport layer emits for each failure class. */
const CODES: Record<NetworkErrorKind, readonly string[]> = {
  dns: ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EAI_MEMORY", "EAI_SYSTEM", "DNS_E_NAME_NOT_FOUND", "DNS_E_QUERY_PENDING"],
  timeout: ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "connection_timeout"],
  refused: ["ECONNREFUSED"],
  reset: ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ERR_SOCKET_CONNECTION_RESET", "ENETRESET", "ECONNABORTED"],
  unreachable: ["ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "EADDRNOTAVAIL"],
  tls: [
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
    "CERT_UNTRUSTED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_BAD_CERTIFICATE", "ERR_SSL_",
  ],
  aborted: ["UND_ERR_ABORTED", "ABORT_ERR"],
  not_found: [],
  authentication: [],
  permission: [],
  rate_limit: [],
  bad_request: [],
  server_error: [],
};

const KIND_HINTS: Partial<Record<NetworkErrorKind, string>> = {
  dns: "Check the base-URL setting, or run `nova --doctor` to test each endpoint.",
  timeout: "Retry, or run `nova --doctor` to see exactly which endpoint is slow or blocked.",
  refused: "A firewall, proxy, or the host itself is refusing the connection. Run `nova --doctor` to confirm.",
  reset: "A proxy or firewall may be dropping the connection. Retry, or run `nova --doctor`.",
  unreachable: "The network cannot reach this destination — check the connection or a blocking firewall.",
  tls: "If a corporate proxy is intercepting traffic this is expected; otherwise the certificate may be misconfigured.",
};

/** The SDKs wrap the transport error; unwrap a few levels so classification sees the real one. */
function unwrap(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") break;
    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) break;
    current = cause;
  }
  return current;
}

function codeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function nameOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const name = (error as Error).name;
  return typeof name === "string" ? name : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function diagnosisFor(kind: NetworkErrorKind, options: ClassifyOptions): NetworkDiagnosis {
  const host = options.host ?? "the server";
  const purpose = options.purpose ? `${options.purpose} to ${host}` : `The request to ${host}`;
  const afterAttempts = options.attempts && options.attempts > 1 ? ` after ${options.attempts} attempts` : "";
  const duplicateRisk = options.retrySuppressed === "output_started"
    ? " Nova did not retry because output had already started; retrying automatically could duplicate output, charges, or tool actions."
    : "";
  switch (kind) {
    case "dns":
      return {
        kind,
        message: `${purpose} could not be resolved — DNS failed for ${host}, so the address may be wrong or the network's resolver is blocking it.`,
        hint: KIND_HINTS.dns,
      };
    case "timeout":
      return {
        kind,
        message: `${purpose} timed out${afterAttempts} — ${host} is slow, or the network is blocking it.${duplicateRisk}`,
        hint: options.retrySuppressed ? "Review any partial output before retrying manually." : KIND_HINTS.timeout,
      };
    case "refused":
      return {
        kind,
        message: `${purpose} was refused — nothing is listening at ${host}, or a firewall/proxy blocked it.`,
        hint: KIND_HINTS.refused,
      };
    case "reset":
      return {
        kind,
        message: `The connection to ${host} was reset mid-request${afterAttempts} — a proxy, firewall, or the server dropped it.${duplicateRisk}`,
        hint: options.retrySuppressed ? "Review any partial output before retrying manually." : KIND_HINTS.reset,
      };
    case "unreachable":
      return {
        kind,
        message: `No network route to ${host} — the destination is unreachable from this network.`,
        hint: KIND_HINTS.unreachable,
      };
    case "tls":
      return {
        kind,
        message: `The TLS certificate for ${host} could not be verified — a proxy is intercepting the connection, or the certificate is invalid.`,
        hint: KIND_HINTS.tls,
      };
    case "aborted":
      return {
        kind,
        message: `${purpose} was aborted before completing — it timed out or was cancelled.`,
      };
    case "not_found":
      return {
        kind,
        message: `${purpose} returned 404 Not Found — the host is reachable, but the API route or selected model does not exist.`,
        hint: "For CircuitNotion use a base URL ending in /v1, then choose a live model with `/model` or refresh `/models`. Run `nova --doctor` to verify the endpoint.",
      };
    case "authentication":
      return {
        kind,
        message: `${purpose} rejected the configured credentials (401 Unauthorized).`,
        hint: "Open `/settings` and replace the provider API key, then run `nova --doctor` before retrying.",
      };
    case "permission":
      return {
        kind,
        message: `${purpose} denied this account or model (403 Forbidden).`,
        hint: "Confirm the account can use the selected model, or choose an available model with `/model`.",
      };
    case "rate_limit":
      return {
        kind,
        message: `${purpose} is still rate-limited${afterAttempts}.`,
        hint: "Wait briefly and retry, or choose another available model with `/model`.",
      };
    case "bad_request":
      return {
        kind,
        message: `${purpose} rejected the request as invalid. The selected model may not support this request or tool-calling format.`,
        hint: "Refresh `/models`, choose a compatible model with `/model`, or run `nova --doctor` to verify the provider configuration.",
      };
    case "server_error":
      return {
        kind,
        message: `${purpose} remained unavailable${afterAttempts} because the provider returned a server error.`,
        hint: "The request was retried safely. Wait briefly, check the provider status, or select another model with `/model`.",
      };
  }
}

/**
 * Classifies a thrown error as a network failure, or returns null when it is not one.
 *
 * The `host` in the message is the caller's `options.host` when provided; otherwise it is taken
 * from the error itself (e.g. "getaddrinfo ENOTFOUND api.example.com") so a bare undici error
 * still names the endpoint.
 */
export function classifyNetworkError(error: unknown, options: ClassifyOptions = {}): NetworkDiagnosis | null {
  const raw = unwrap(error);
  const retry = error !== null && typeof error === "object" ? error as { attempts?: unknown; retrySuppressed?: unknown } : undefined;
  const context: ClassifyOptions = {
    ...options,
    ...(typeof retry?.attempts === "number" ? { attempts: retry.attempts } : {}),
    ...(retry?.retrySuppressed === "output_started" ? { retrySuppressed: "output_started" as const } : {}),
  };
  const name = nameOf(raw) ?? nameOf(error);
  const code = codeOf(raw) ?? codeOf(error);
  const message = messageOf(raw);

  // OpenAI-compatible SDKs attach the HTTP status to the outer API error. A 404 is not a broken
  // network: it is almost always an omitted `/v1` base path or a model id no longer in the live
  // catalog, and both have concrete fixes the raw "404 not found" fails to name.
  if (statusOf(error) === 404 || statusOf(raw) === 404 || /^404\b|\b404 not found\b/i.test(messageOf(error))) {
    return diagnosisFor("not_found", context);
  }

  const status = statusOf(error) ?? statusOf(raw);
  if (status === 401) return diagnosisFor("authentication", context);
  if (status === 403) return diagnosisFor("permission", context);
  if (status === 429) return diagnosisFor("rate_limit", context);
  if (status === 400 || status === 422) return diagnosisFor("bad_request", context);
  if (status === 408) return diagnosisFor("timeout", context);
  if (status === 409 || status === 425 || (status !== undefined && status >= 500 && status < 600)) {
    return diagnosisFor("server_error", context);
  }

  // AbortSignal.timeout and user cancellation both surface as an abort; without more signal it is
  // safest to call it a timeout — a cancelled call is still "did not complete", never "internet".
  if (name === "AbortError" || name === "TimeoutError" || name === "APIConnectionTimeoutError") {
    return diagnosisFor("timeout", context);
  }
  // The SDKs surface any transport failure as APIConnectionError with the real error as `cause`.
  if (name === "APIConnectionError") {
    return classifyNetworkError(raw, context) ?? { kind: "reset", message: `The connection failed — ${message}`, hint: KIND_HINTS.reset };
  }
  if (name === "APIUserAbortError") return null; // the user (or the runtime) cancelled; not a network fault

  const hostFromError = /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([^\s]+)/i.exec(message)?.[1]
    ?? /([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/.exec(message)?.[1];
  const host = options.host ?? hostFromError;

  for (const kind of Object.keys(CODES) as NetworkErrorKind[]) {
    if (code && CODES[kind].some((candidate) => code === candidate || (candidate.endsWith("_") && code.startsWith(candidate)))) {
      return diagnosisFor(kind, { ...context, host });
    }
  }
  // Node's fetch wraps undici failures in `TypeError: fetch failed` whose `cause` has the code;
  // if unwrapping already happened, the raw error itself may carry the useful text.
  if (code || /fetch failed/i.test(message) || /network|socket|tls|certificate/i.test(message)) {
    return { kind: "reset", message: `The connection to ${host} failed — ${message}`, hint: KIND_HINTS.reset };
  }
  return null;
}

export { hostOf };
