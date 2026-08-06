/**
 * E2B sandbox lifecycle webhooks.
 *
 * Two things about the documented contract shape this module:
 *
 * 1. The `e2b-signature` header is **not** an HMAC despite being described as one. It is a plain
 *    SHA-256 of `secret + body`, base64 with trailing `=` stripped. That construction is
 *    vulnerable to length extension, so a valid signature proves far less than an HMAC would:
 *    an attacker who has seen one delivery can append bytes and still produce a valid signature.
 *    Verification is therefore treated as a first filter, not as authority — every handler must
 *    still resolve the sandbox id to a row it already owns and ignore anything else the payload
 *    claims. E2B's own example compares with `==`, which leaks timing; this compares in
 *    constant time.
 * 2. Deliveries retry up to three times, ten seconds apart, so duplicates are expected rather
 *    than exceptional. `e2b-delivery-id` is the documented idempotency key.
 */
export const E2B_SIGNATURE_HEADER = "e2b-signature";
export const E2B_DELIVERY_HEADER = "e2b-delivery-id";
export const E2B_WEBHOOK_HEADER = "e2b-webhook-id";

export type E2BLifecycleType =
  | "sandbox.lifecycle.created"
  | "sandbox.lifecycle.updated"
  | "sandbox.lifecycle.paused"
  | "sandbox.lifecycle.resumed"
  | "sandbox.lifecycle.killed"
  | "sandbox.lifecycle.checkpointed";

export type E2BLifecycleEvent = {
  id: string;
  type: E2BLifecycleType;
  timestamp: string;
  sandboxId: string;
  /** Present only on killed and paused events, per the documented payload. */
  executionTimeMs?: number;
};

const LIFECYCLE_TYPES = new Set<string>([
  "sandbox.lifecycle.created",
  "sandbox.lifecycle.updated",
  "sandbox.lifecycle.paused",
  "sandbox.lifecycle.resumed",
  "sandbox.lifecycle.killed",
  "sandbox.lifecycle.checkpointed",
]);

/**
 * Web Crypto rather than node:crypto: this runs inside a Convex HTTP action, which uses the
 * default V8 runtime where node built-ins are unavailable (convex/http.ts already keeps a
 * separate Web Crypto verifier for GitHub for exactly this reason).
 *
 * Exported so tests sign a body precisely the way E2B documents it.
 */
export async function e2bSignature(secret: string, rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + rawBody));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

/** Compares in constant time; E2B's own documented example uses `==`, which leaks by timing. */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyE2BSignature(secret: string, rawBody: string, provided: string | null): Promise<boolean> {
  if (!secret || !provided) return false;
  return constantTimeEquals(await e2bSignature(secret, rawBody), provided);
}

/**
 * Parses a verified delivery. Returns null for anything that is not a lifecycle event this
 * system understands, so an unrecognized or future event type is ignored rather than guessed at.
 */
export function parseE2BLifecycleEvent(rawBody: string): E2BLifecycleEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const type = payload.type;
  const sandboxId = payload.sandbox_id;
  const id = payload.id;
  if (typeof type !== "string" || !LIFECYCLE_TYPES.has(type)) return null;
  if (typeof sandboxId !== "string" || !sandboxId.trim()) return null;
  if (typeof id !== "string" || !id.trim()) return null;

  const eventData = typeof payload.event_data === "object" && payload.event_data !== null ? (payload.event_data as Record<string, unknown>) : {};
  const execution = typeof eventData.execution === "object" && eventData.execution !== null ? (eventData.execution as Record<string, unknown>) : {};
  const executionTime = execution.execution_time;

  return {
    id,
    type: type as E2BLifecycleType,
    timestamp: typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString(),
    sandboxId,
    executionTimeMs: typeof executionTime === "number" && Number.isFinite(executionTime) ? executionTime : undefined,
  };
}

/**
 * Whether an event means the sandbox is gone for good.
 *
 * Only "killed" ends a sandbox. A paused or checkpointed sandbox can still be resumed, so
 * treating those as death would fail a step that is merely suspended.
 */
export function isSandboxTerminated(event: E2BLifecycleEvent): boolean {
  return event.type === "sandbox.lifecycle.killed";
}
