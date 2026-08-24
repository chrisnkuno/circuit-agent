const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4_096;

type Fetch = typeof fetch;

export type TelegramSendResult = { messageId: number };

export async function sendTelegramMessage(input: { botToken: string; chatId: string; text: string }, request: Fetch = fetch): Promise<TelegramSendResult> {
  if (!input.botToken.trim()) throw new Error("Telegram bot token is required");
  if (!input.chatId.trim()) throw new Error("Telegram chat id is required");
  if (!input.text.trim()) throw new Error("Telegram message text is required");
  if (input.text.length > MAX_MESSAGE_LENGTH) throw new Error(`Telegram message text exceeds the ${MAX_MESSAGE_LENGTH} character limit`);
  const response = await request(`${TELEGRAM_API}/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
  });
  const body = await readJson(response);
  if (!response.ok || !body.ok) throw new Error(`Telegram sendMessage failed (${response.status})`);
  return { messageId: Number(body.result?.message_id) };
}

export type TelegramIncomingMessage = { chatId: string; text: string };

/** Extracts only what's needed from a Telegram webhook update; anything else (edits, non-text, channel posts) is ignored, not mishandled. */
export function parseTelegramUpdate(body: unknown): TelegramIncomingMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const chat = (message as Record<string, unknown>).chat;
  const chatId = typeof chat === "object" && chat !== null ? (chat as Record<string, unknown>).id : undefined;
  const text = (message as Record<string, unknown>).text;
  if ((typeof chatId !== "number" && typeof chatId !== "string") || typeof text !== "string") return null;
  return { chatId: String(chatId), text };
}

export type ChannelCommand =
  | { kind: "link"; code: string }
  | { kind: "run"; objective: string }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

/** Commands only, deliberately — free text is never routed to a real, billed run by accident. */
export function parseChannelCommand(text: string): ChannelCommand {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "unknown", raw: text };
  const [head, ...rest] = trimmed.split(/\s+/);
  // Group chats send "/run@YourBotName ..."; strip the "@botname" suffix Telegram appends.
  const command = head.toLowerCase().replace(/^\//, "").split("@")[0];
  if (command === "link") {
    const code = rest[0]?.trim();
    return code ? { kind: "link", code } : { kind: "unknown", raw: text };
  }
  if (command === "run") {
    const objective = rest.join(" ").trim();
    return objective ? { kind: "run", objective } : { kind: "unknown", raw: text };
  }
  if (command === "status") return { kind: "status" };
  if (command === "help" || command === "start") return { kind: "help" };
  return { kind: "unknown", raw: text };
}

/** Telegram echoes back whatever secret_token was set on setWebhook in this header on every real delivery. */
export function verifyTelegramSecret(headerValue: string | null, expectedSecret: string): boolean {
  return Boolean(expectedSecret) && headerValue === expectedSecret;
}

async function readJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return {}; }
}
