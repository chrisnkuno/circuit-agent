import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { NovaAgent } from "./agent";
import { NovaSessionDaemon, type DaemonAgentFactoryContext, type DaemonNotification } from "./daemon";
import { loadSession } from "./session";

const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
let root: string;
let daemon: NovaSessionDaemon;

function modelWith(
  complete: (request: AgentModelRequest, call: number) => Promise<Partial<AgentModelTurn>> | Partial<AgentModelTurn>,
): AgentTurnProvider & { calls: number } {
  return {
    calls: 0,
    async complete(request) {
      this.calls += 1;
      return {
        responseId: `response_${this.calls}`,
        model: "daemon-test",
        finishReason: "stop",
        content: "Done.",
        toolCalls: [],
        usage,
        ...await complete(request, this.calls),
      } as AgentModelTurn;
    },
  };
}

function factory(model: AgentTurnProvider) {
  return ({ onEvent, approve }: DaemonAgentFactoryContext) => new NovaAgent({
    root,
    model,
    prices,
    mode: "build",
    approve,
    onEvent,
    git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repository" }),
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-daemon-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
  daemon = new NovaSessionDaemon();
});

afterEach(async () => {
  await daemon.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

describe("NovaSessionDaemon", () => {
  it("owns one session while multiple clients attach to it", async () => {
    const model = modelWith(() => ({ content: "Shared result." }));
    const first = daemon.connect({ id: "tui" });
    const opened = await first.open(factory(model));
    first.disconnect();

    const ide = daemon.connect({ id: "ide" });
    expect(ide.attach(opened.sessionId).sessionId).toBe(opened.sessionId);
    expect((await ide.send("continue", "command_1")).summary).toBe("Shared result.");
    expect(model.calls).toBe(1);

    const saved = await loadSession(root, opened.sessionId);
    expect(saved?.messages.some((message) => message.content === "continue")).toBe(true);
  });

  it("binds retries to one result by command id", async () => {
    const model = modelWith(() => ({ content: "Only once." }));
    const client = daemon.connect({ id: "headless" });
    await client.open(factory(model));

    const first = client.send("do it", "stable_request");
    const retry = client.send("do it", "stable_request");
    expect(retry).toBe(first);
    expect((await retry).summary).toBe("Only once.");
    expect(model.calls).toBe(1);
  });

  it("serializes different turns for the same session", async () => {
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    const model = modelWith(async (request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(request.messages.at(-1)?.content ?? "");
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { content: "ok" };
    });
    const client = daemon.connect({ id: "tests" });
    await client.open(factory(model));
    await Promise.all([
      client.send("first", "command_first"),
      client.send("second", "command_second"),
    ]);
    expect(maximum).toBe(1);
    expect(order).toEqual(["first", "second"]);
  });

  it("returns the complete transcript atomically when a model handoff retires the agent", async () => {
    const firstModel = modelWith(() => ({ content: "The project codename is cobalt." }));
    const first = daemon.connect({ id: "before-model-switch" });
    await first.open(factory(firstModel));
    await first.send("Remember the project codename.", "command_remember");

    const carried = await first.relinquish();
    expect(carried?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember the project codename." }),
      expect.objectContaining({ role: "assistant", content: "The project codename is cobalt." }),
    ]));

    const requests: AgentModelRequest[] = [];
    const secondModel = modelWith((request) => {
      requests.push(request);
      return { content: "cobalt" };
    });
    const second = daemon.connect({ id: "after-model-switch" });
    await second.open(factory(secondModel), carried);
    await second.send("What was the codename?", "command_recall");

    expect(requests[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember the project codename." }),
      expect.objectContaining({ role: "assistant", content: "The project codename is cobalt." }),
    ]));
    expect(requests[0].messages.at(-1)).toEqual({ role: "user", content: "What was the codename?" });
  });

  it("brokers approvals through the attached client and fans out events", async () => {
    const notifications: DaemonNotification[] = [];
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_1", name: "edit_file", arguments: { path: "app.ts", oldText: "1", newText: "2" } }] }
      : { content: "Edited." });
    const client = daemon.connect({
      id: "desktop",
      onNotification: (notification) => notifications.push(notification),
      approve: async (request) => request.toolName === "edit_file" ? "allow" : "deny",
    });
    await client.open(factory(model));
    const result = await client.send("edit it", "command_edit");
    expect(result.status).toBe("needs_verification");
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("2");
    expect(notifications.some((event) => event.type === "turn_started")).toBe(true);
    expect(notifications.some((event) => event.type === "agent_event")).toBe(true);
    expect(notifications.some((event) => event.type === "turn_finished")).toBe(true);
  });

  it("carries the safety assessment on an approval request, not just its summary", async () => {
    // A client rebuilding the terminal's "Safety guard: ..." warning needs to know *why* auto mode
    // did not silently approve the call — dropping this field would silently lose that warning for
    // any client built against the daemon instead of the in-process ApprovalRequest.
    let seenSafety: unknown;
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "run_1", name: "run_command", arguments: { command: "git push" } }] }
      : { content: "Pushed." });
    const client = daemon.connect({
      id: "safety-check",
      approve: async (request) => { seenSafety = request.safety; return "deny" as const; },
    });
    await client.open(({ onEvent, approve }) => new NovaAgent({
      root, model, prices, mode: "auto", approve, onEvent, git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repository" }),
    }));
    await client.send("push it", "command_push");
    expect(seenSafety).toMatchObject({ sensitive: true, categories: expect.arrayContaining(["production"]) });
  });

  it("carries what an edit_file or write_file call would change, for a client to preview before deciding", async () => {
    let seenPreviews: unknown[] = [];
    const model = modelWith((_request, call) => {
      if (call === 1) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_1", name: "edit_file", arguments: { path: "app.ts", oldText: "1", newText: "2" } }] };
      if (call === 2) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "write_1", name: "write_file", arguments: { path: "new.ts", content: "export const x = 1;\n" } }] };
      return { content: "Done." };
    });
    const client = daemon.connect({
      id: "preview-check",
      approve: async (request) => { seenPreviews.push(request.preview); return "allow" as const; },
    });
    await client.open(factory(model));
    await client.send("edit and add a file", "command_preview");
    expect(seenPreviews[0]).toEqual({ toolName: "edit_file", path: "app.ts", oldText: "1", newText: "2" });
    expect(seenPreviews[1]).toEqual({ toolName: "write_file", path: "new.ts", content: "export const x = 1;\n" });
  });

  it("carries no preview for a tool with no textual before/after, like run_command", async () => {
    let seenPreview: unknown = "not set";
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "run_1", name: "run_command", arguments: { command: "npm test" } }] }
      : { content: "Ran it." });
    const client = daemon.connect({
      id: "no-preview-check",
      approve: async (request) => { seenPreview = request.preview; return "allow" as const; },
    });
    await client.open(factory(model));
    await client.send("run the tests", "command_run");
    expect(seenPreview).toBeUndefined();
  });
});
