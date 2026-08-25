import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportSession, sessionExportPayload } from "./session-export";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";

async function record(): Promise<SessionRecord> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-export-"));
  return {
    schemaVersion: 2, revision: 1, id: "20260825T120000Z-abc123", createdAt: 1, updatedAt: 2,
    root, title: "Debug sk-proj-abcdefghijklmnopqrstuvwxyz", approvals: {}, totalRwf: 4,
    messages: [
      { role: "user", content: "token='abcdefghijklmnopqrstu'" },
      { role: "assistant", content: "done", toolCalls: [{ id: "1", name: "run_command", arguments: { Authorization: "secret" } }] },
      { role: "tool", name: "run_command", toolCallId: "1", content: "raw secret output" },
    ],
  };
}

describe("session export", () => {
  it("redacts secret-shaped text and omits structured tool arguments and output", async () => {
    const source = await record();
    const serialized = JSON.stringify(sessionExportPayload(source, "json"));
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("abcdefghijklmnopqrstu");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("raw secret output");
    expect(serialized).toContain("tool output omitted");
  });

  it("writes markdown, json, and bounded support artifacts with private permissions", async () => {
    const source = await record();
    for (const format of ["markdown", "json", "support"] as const) {
      const file = await exportSession(source, format);
      expect(await fs.readFile(file, "utf8")).toContain(source.id);
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    const support = sessionExportPayload(source, "support");
    expect(support).toHaveProperty("recentMessages");
    expect(support).not.toHaveProperty("messages");
  });
});
