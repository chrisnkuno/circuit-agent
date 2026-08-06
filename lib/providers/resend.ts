const RESEND_API = "https://api.resend.com";
// Resend accepts up to 50 recipients per send; a workspace notification never legitimately
// fans out wider than that, and silently truncating a larger list would hide who was missed.
const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_LENGTH = 200;

type Fetch = typeof fetch;

export type EmailSendResult = { id: string };

export type EmailMessage = {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
};

function isEmailAddress(value: string): boolean {
  // Deliberately permissive: the provider is the authority on deliverability. This only rejects
  // values that cannot be an address at all, so a typo fails here instead of at the provider.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

/**
 * Sends one transactional email through Resend.
 *
 * Fails closed and loudly: a caller that cannot tell a delivered message from a swallowed one
 * would report notifications that never arrived. Best-effort behaviour belongs at the call
 * site, which knows whether a failed notification should affect what triggered it.
 */
export async function sendEmail(message: EmailMessage, request: Fetch = fetch): Promise<EmailSendResult> {
  if (!message.apiKey.trim()) throw new Error("Resend API key is required");
  if (!isEmailAddress(message.from)) throw new Error("A valid sender address is required");
  if (message.to.length === 0) throw new Error("At least one recipient is required");
  if (message.to.length > MAX_RECIPIENTS) throw new Error(`Recipient list exceeds the ${MAX_RECIPIENTS} address limit`);
  const invalid = message.to.find((address) => !isEmailAddress(address));
  if (invalid) throw new Error(`Recipient is not a valid email address: ${invalid}`);
  if (!message.subject.trim()) throw new Error("Email subject is required");
  if (message.subject.length > MAX_SUBJECT_LENGTH) throw new Error(`Email subject exceeds the ${MAX_SUBJECT_LENGTH} character limit`);
  if (!message.text.trim()) throw new Error("Email body is required");

  const response = await request(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${message.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, text: message.text }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body only matters for the error message below.
  }
  if (!response.ok) {
    const detail = typeof body.message === "string" ? body.message : response.statusText;
    // The API key is in the request, never in the error: this string is stored and displayed.
    throw new Error(`Resend send failed (${response.status}): ${detail}`.slice(0, 300));
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new Error("Resend accepted the request without returning a message id");
  return { id };
}
