import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@circuit-nova/nova-core/agent-runtime";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { SECRET_PATTERNS } from "@circuit-nova/nova-core/nova-cli/secret-scan";

export type ExportFormat = "markdown" | "json" | "support";

function redactText(value: string): string {
  let redacted = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[REDACTED]@");
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(new RegExp(pattern.regex.source, "g"), `[REDACTED ${pattern.name}]`);
  return redacted;
}

function safeMessages(messages: readonly AgentMessage[]): Array<{ role: string; content: string; tool?: string }> {
  return messages.filter((message) => !message.internal).map((message) => {
    if (message.role === "tool") return { role: "tool", tool: message.name, content: "[tool output omitted from export]" };
    if ("toolCalls" in message) return { role: "assistant", content: redactText(message.content), tool: `${message.toolCalls.length} tool call(s) omitted` };
    return { role: message.role, content: redactText(message.content) };
  });
}

export function sessionExportPayload(record: SessionRecord, format: ExportFormat): Record<string, unknown> {
  const messages = safeMessages(record.messages);
  const base = {
    schema: `nova-session-export/v1`,
    sessionId: record.id,
    title: redactText(record.title),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    mode: record.mode,
    totalRwf: record.totalRwf,
    workspace: path.basename(record.root),
  };
  return format === "support"
    ? { ...base, messageCount: messages.length, recentMessages: messages.slice(-20) }
    : { ...base, messages };
}

function markdownExport(record: SessionRecord): string {
  const payload = sessionExportPayload(record, "markdown") as ReturnType<typeof sessionExportPayload> & { messages: Array<{ role: string; content: string; tool?: string }> };
  const lines = [`# ${payload.title}`, "", `Session: ${payload.sessionId}`, `Updated: ${payload.updatedAt}`, `Mode: ${payload.mode ?? "unknown"}`, ""];
  for (const message of payload.messages) {
    lines.push(`## ${message.role}${message.tool ? ` — ${message.tool}` : ""}`, "", message.content, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/** Writes a private-by-default, redacted artifact under the project's .nova directory. */
export async function exportSession(record: SessionRecord, format: ExportFormat): Promise<string> {
  const directory = path.join(record.root, ".nova", "exports");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const extension = format === "markdown" ? "md" : "json";
  const file = path.join(directory, `${record.id}-${format}.${extension}`);
  const body = format === "markdown"
    ? markdownExport(record)
    : `${JSON.stringify(sessionExportPayload(record, format), null, 2)}\n`;
  await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}
