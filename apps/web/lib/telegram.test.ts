import { describe, expect, it, vi } from "vitest";
import { parseChannelCommand, parseTelegramUpdate, sendTelegramMessage, verifyTelegramSecret } from "./telegram";

describe("sendTelegramMessage", () => {
  it("posts to the bot's sendMessage endpoint with the chat id and text", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }));
    const result = await sendTelegramMessage({ botToken: "bot-token", chatId: "12345", text: "hello" }, request as unknown as typeof fetch);
    expect(result).toEqual({ messageId: 42 });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: "12345", text: "hello" });
  });

  it("rejects empty credentials or text before ever calling Telegram", async () => {
    const request = vi.fn();
    await expect(sendTelegramMessage({ botToken: "", chatId: "1", text: "hi" }, request as unknown as typeof fetch)).rejects.toThrow("bot token");
    await expect(sendTelegramMessage({ botToken: "t", chatId: "", text: "hi" }, request as unknown as typeof fetch)).rejects.toThrow("chat id");
    await expect(sendTelegramMessage({ botToken: "t", chatId: "1", text: "" }, request as unknown as typeof fetch)).rejects.toThrow("text is required");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects text over Telegram's 4096 character limit", async () => {
    const request = vi.fn();
    await expect(sendTelegramMessage({ botToken: "t", chatId: "1", text: "x".repeat(4_097) }, request as unknown as typeof fetch)).rejects.toThrow("4096");
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when Telegram reports ok:false even with a 200 status", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }));
    await expect(sendTelegramMessage({ botToken: "t", chatId: "1", text: "hi" }, request as unknown as typeof fetch)).rejects.toThrow("sendMessage failed");
  });
});

describe("parseTelegramUpdate", () => {
  it("extracts chat id and text from a real-shaped webhook update", () => {
    const update = { update_id: 1, message: { message_id: 1, chat: { id: 555, type: "private" }, text: "/run fix the bug", date: 0 } };
    expect(parseTelegramUpdate(update)).toEqual({ chatId: "555", text: "/run fix the bug" });
  });

  it("returns null for updates with no text message (edits, photos, channel posts)", () => {
    expect(parseTelegramUpdate({ update_id: 1 })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 1 } } })).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate("not an object")).toBeNull();
  });
});

describe("parseChannelCommand", () => {
  it("parses /link with its code", () => {
    expect(parseChannelCommand("/link ABC123")).toEqual({ kind: "link", code: "ABC123" });
  });

  it("parses /run with the full objective, including a group-chat @botname suffix", () => {
    expect(parseChannelCommand("/run fix the flaky test")).toEqual({ kind: "run", objective: "fix the flaky test" });
    expect(parseChannelCommand("/run@CircuitNovaBot fix the flaky test")).toEqual({ kind: "run", objective: "fix the flaky test" });
  });

  it("parses /status and /help", () => {
    expect(parseChannelCommand("/status")).toEqual({ kind: "status" });
    expect(parseChannelCommand("/help")).toEqual({ kind: "help" });
    expect(parseChannelCommand("/start")).toEqual({ kind: "help" });
  });

  it("never routes free text to a real run — only recognized commands do anything", () => {
    expect(parseChannelCommand("please fix my code")).toEqual({ kind: "unknown", raw: "please fix my code" });
    expect(parseChannelCommand("/run")).toEqual({ kind: "unknown", raw: "/run" });
    expect(parseChannelCommand("/link")).toEqual({ kind: "unknown", raw: "/link" });
    expect(parseChannelCommand("")).toEqual({ kind: "unknown", raw: "" });
  });
});

describe("verifyTelegramSecret", () => {
  it("accepts only an exact match, and never a configured-empty secret", () => {
    expect(verifyTelegramSecret("s3cret", "s3cret")).toBe(true);
    expect(verifyTelegramSecret("wrong", "s3cret")).toBe(false);
    expect(verifyTelegramSecret(null, "s3cret")).toBe(false);
    expect(verifyTelegramSecret("anything", "")).toBe(false);
  });
});
