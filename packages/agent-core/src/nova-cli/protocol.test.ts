import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTurnTransition, EventJournal, readEventJournal, runtimeEventForJournal } from "./protocol";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-protocol-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("turn state invariants", () => {
  it("accepts legal progress and rejects terminal or skipped transitions", () => {
    expect(() => assertTurnTransition("queued", "running")).not.toThrow();
    expect(() => assertTurnTransition("running", "completed")).not.toThrow();
    expect(() => assertTurnTransition("completed", "running")).toThrow(/Illegal/);
    expect(() => assertTurnTransition("queued", "completed")).toThrow(/Illegal/);
  });
});

describe("event journal", () => {
  it("redacts secret-shaped arguments and bounds large tool payloads", () => {
    const event = runtimeEventForJournal({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "external",
      effect: "external",
      arguments: { apiToken: "do-not-store", body: "x".repeat(5_000) },
    });
    expect(event.type).toBe("tool_call");
    if (event.type !== "tool_call") return;
    expect(event.arguments.apiToken).toBe("[REDACTED]");
    expect(String(event.arguments.body)).toContain("chars omitted; original sha256=");
    expect(String(event.arguments.body).length).toBeLessThan(4_200);
  });

  it("serializes concurrent appends into one verifiable hash chain", async () => {
    const journal = new EventJournal(root, "session_1");
    await Promise.all([
      journal.append({ type: "turn_status", turnId: "turn_1", from: "queued", to: "running" }),
      journal.append({ type: "turn_status", turnId: "turn_1", from: "running", to: "completed" }),
    ]);
    await journal.close();

    const events = await readEventJournal(root, "session_1");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1].previousHash).toBe(events[0].hash);
  });

  it("detects modification and ignores only a crash-truncated final line", async () => {
    const journal = new EventJournal(root, "session_2");
    await journal.append({ type: "turn_status", turnId: "turn_1", from: "queued", to: "running" }, { durable: true });
    await journal.close();
    const file = path.join(root, ".nova", "events", "session_2.jsonl");

    await fs.appendFile(file, "{\"partial\":");
    expect(await readEventJournal(root, "session_2")).toHaveLength(1);

    const resumed = new EventJournal(root, "session_2");
    await resumed.append({ type: "turn_status", turnId: "turn_2", from: "queued", to: "running" });
    await resumed.close();
    expect(await readEventJournal(root, "session_2")).toHaveLength(2);

    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, original.replace('"running"', '"completed"'));
    await expect(readEventJournal(root, "session_2")).rejects.toThrow(/integrity/);
  });
});
