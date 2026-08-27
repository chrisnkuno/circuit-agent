import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startAnthropicStub, type AnthropicStub } from "../test/anthropic-stub.js";
import { NovaHost } from "./host.js";
import type { IpcEvent, NovaSettings } from "./protocol.js";

/**
 * Two tabs, one host, and the question the whole change exists to answer: do they actually run at
 * the same time, and does each one's output end up in its own transcript?
 *
 * Everything else about tabs can be checked with pure functions — `tabs.ts` on either side of the
 * IPC boundary is exhaustively covered that way. These two properties cannot: they are facts about
 * a live daemon holding two agents, and asserting them needs the real host with a real (stubbed)
 * provider behind it. They are also the two that fail silently. A serialised second turn looks like
 * a slow one; a misrouted event looks like an answer that arrived.
 */

let stub: AnthropicStub;
let roots: string[] = [];
const exec = promisify(execFile);

const settings = (): NovaSettings => ({
  provider: "anthropic",
  apiKey: "sk-ant-test",
  baseUrl: stub.url,
  model: "claude-sonnet-5",
  currency: "USD",
});

beforeAll(async () => {
  stub = await startAnthropicStub();
});

afterAll(async () => {
  await stub.close();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempProject(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nova-tabs-${name}-`));
  roots.push(root);
  return root;
}

async function gitProject(name: string): Promise<string> {
  const root = await tempProject(name);
  await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n", "utf8");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "app.ts"], { cwd: root });
  return root;
}

/** A host plus the event log it emitted, which is the only way to observe routing. */
function bootHost() {
  const events: IpcEvent[] = [];
  const host = new NovaHost((event) => events.push(event));
  const request = async (payload: Record<string, unknown>) =>
    host.handle({ id: `req_${events.length}_${Math.random().toString(36).slice(2)}`, ...payload } as never);
  return { host, events, request };
}

/** Events belonging to one tab, in the order they were emitted. */
const forTab = (events: readonly IpcEvent[], tabId: string) =>
  events.filter((event) => "tabId" in event && event.tabId === tabId);

const textOf = (events: readonly IpcEvent[], tabId: string) =>
  forTab(events, tabId)
    .filter((event) => event.type === "assistant_delta")
    .map((event) => (event as { text: string }).text)
    .join("");

describe("two tabs in one window", () => {
  it("opens a second project without ending the first", async () => {
    // The behaviour this replaces: `buildAgent` began with `disposeAgent()`, so opening anything
    // destroyed whatever was open. That single line was the whole of the one-session limit.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const first = await request({ type: "session.open", root: await tempProject("a") }) as { tabId: string };
    const second = await request({ type: "session.open", root: await tempProject("b") }) as { tabId: string };

    expect(second.tabId).not.toBe(first.tabId);
    const listed = await request({ type: "tabs.list" }) as { activeTabId: string; tabs: Array<{ tabId: string }> };
    expect(listed.tabs.map((tab) => tab.tabId)).toEqual([first.tabId, second.tabId]);
    // The newly opened one is in front, and the first is still there behind it.
    expect(listed.activeTabId).toBe(second.tabId);
  }, 60_000);

  it("opens into a named tab rather than beside it, which is what changing folder means", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("c") }) as { tabId: string };
    const reopened = await request({ type: "session.open", root: await tempProject("d"), tabId: opened.tabId }) as {
      tabId: string;
      sessionId: string;
    };

    expect(reopened.tabId).toBe(opened.tabId);
    const listed = await request({ type: "tabs.list" }) as { tabs: unknown[] };
    expect(listed.tabs).toHaveLength(1);
  }, 60_000);

  it("runs both tabs' turns at the same time", async () => {
    // The claim, stated as event order rather than as a stopwatch: if turns were serialised, the
    // second could not *start* before the first had finished. `NovaSessionDaemon` serialises per
    // session — each live session has its own tail — so both are in flight at once.
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const first = await request({ type: "session.open", root: await tempProject("e") }) as { tabId: string };
    const second = await request({ type: "session.open", root: await tempProject("f") }) as { tabId: string };

    // Two slow answers, so neither can complete before the other has begun by accident of speed.
    stub.enqueue({ kind: "text", text: "one two three four", chunkSize: 4, chunkDelayMs: 40 });
    stub.enqueue({ kind: "text", text: "five six seven eight", chunkSize: 4, chunkDelayMs: 40 });

    await Promise.all([
      request({ type: "turn.send", objective: "count", tabId: first.tabId }),
      request({ type: "turn.send", objective: "count", tabId: second.tabId }),
    ]);

    const statuses = events.filter((event) => event.type === "turn_status") as Array<{ status: string; tabId?: string }>;
    const secondStarted = statuses.findIndex((event, index) =>
      event.status === "running" && statuses.slice(0, index).some((earlier) => earlier.tabId !== event.tabId));
    const firstFinished = statuses.findIndex((event) => event.status !== "running");
    expect(secondStarted).toBeGreaterThanOrEqual(0);
    // Both turns were running before either had finished — which is what "in parallel" means.
    expect(secondStarted).toBeLessThan(firstFinished);
  }, 60_000);

  it("puts each tab's answer in its own transcript", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const first = await request({ type: "session.open", root: await tempProject("g") }) as { tabId: string };
    const second = await request({ type: "session.open", root: await tempProject("h") }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "ALPHA" });
    await request({ type: "turn.send", objective: "say alpha", tabId: first.tabId });
    stub.enqueue({ kind: "text", text: "BETA" });
    await request({ type: "turn.send", objective: "say beta", tabId: second.tabId });

    expect(textOf(events, first.tabId)).toContain("ALPHA");
    expect(textOf(events, first.tabId)).not.toContain("BETA");
    expect(textOf(events, second.tabId)).toContain("BETA");
    expect(textOf(events, second.tabId)).not.toContain("ALPHA");
  }, 60_000);

  it("stamps every session event with the tab it came from", async () => {
    // Untagged events are unroutable: with two turns streaming, the receiver's only options are to
    // guess or to drop, and both are wrong in a way nothing on screen would reveal.
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("i") }) as { tabId: string };
    stub.enqueue({ kind: "text", text: "tagged" });
    await request({ type: "turn.send", objective: "hello", tabId: opened.tabId });

    const sessionEvents = events.filter((event) => event.type !== "ready");
    expect(sessionEvents.length).toBeGreaterThan(0);
    for (const event of sessionEvents) {
      expect("tabId" in event && event.tabId, `${event.type} carries no tab`).toBe(opened.tabId);
    }
  }, 60_000);

  it("keeps a separate cost ledger per tab, since two tabs are two pieces of work", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const spender = await request({ type: "session.open", root: await tempProject("j") }) as { tabId: string };
    const idle = await request({ type: "session.open", root: await tempProject("k") }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "spending tokens" });
    await request({ type: "turn.send", objective: "spend", tabId: spender.tabId });

    const spent = await request({ type: "cost.get", tabId: spender.tabId }) as { report: string };
    const untouched = await request({ type: "cost.get", tabId: idle.tabId }) as { report: string };
    expect(spent.report).toMatch(/1 request/);
    // A shared ledger would report the first tab's spend against the second's work.
    expect(untouched.report).toMatch(/0 request|No turns|No cost/i);
  }, 60_000);

  it("addresses the tab in front when a request names none, as every old caller does", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const background = await request({ type: "session.open", root: await tempProject("l") }) as { tabId: string };
    const front = await request({ type: "session.open", root: await tempProject("m") }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "unaddressed" });
    await request({ type: "turn.send", objective: "hello" });
    expect(textOf(events, front.tabId)).toContain("unaddressed");
    expect(textOf(events, background.tabId)).toBe("");

    // And "in front" follows tabs.activate, which is how the window keeps the two in step.
    await request({ type: "tabs.activate", tabId: background.tabId });
    stub.enqueue({ kind: "text", text: "now here" });
    await request({ type: "turn.send", objective: "hello again" });
    expect(textOf(events, background.tabId)).toContain("now here");
  }, 60_000);

  it("closes one tab without disturbing the other", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const closing = await request({ type: "session.open", root: await tempProject("n") }) as { tabId: string };
    const surviving = await request({ type: "session.open", root: await tempProject("o") }) as { tabId: string };

    const after = await request({ type: "tabs.close", tabId: closing.tabId }) as { tabs: Array<{ tabId: string }> };
    expect(after.tabs.map((tab) => tab.tabId)).toEqual([surviving.tabId]);

    // The survivor still works, which is the part that would break if closing released the wrong
    // client or tore down something shared.
    stub.enqueue({ kind: "text", text: "still here" });
    await request({ type: "turn.send", objective: "alive?", tabId: surviving.tabId });
    expect(textOf(events, surviving.tabId)).toContain("still here");
  }, 60_000);

  it("refuses a request naming a tab that does not exist, rather than acting on another one", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    await request({ type: "session.open", root: await tempProject("p") });
    await expect(request({ type: "turn.send", objective: "hello", tabId: "tab_404" })).rejects.toThrow(/No such tab/);
  }, 60_000);
});

/**
 * Where a write actually lands.
 *
 * The window reports a write as a line in the transcript, and a line in a transcript is not a file.
 * Between the two sit a workspace, a root and — in sandbox mode — a machine that is not this one,
 * so "it said it wrote the file" and "the file exists, in the right place" are separate claims and
 * only the second one is worth anything to the person who asked for the work.
 */
describe("files a turn creates", () => {
  it("streams named work and returns the actual patch, then announces the refreshed tree", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await gitProject("live-diff");
    const opened = await request({ type: "session.open", root, mode: "auto" }) as { tabId: string };

    stub.enqueue({ kind: "tool_call", toolName: "edit_file", input: { path: "app.ts", oldText: "value = 1", newText: "value = 2" } });
    stub.enqueue({ kind: "text", text: "Updated app.ts." });
    await request({ type: "turn.send", objective: "update app.ts", tabId: opened.tabId });

    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("value = 2");
    expect(forTab(events, opened.tabId)).toContainEqual(expect.objectContaining({ type: "checkpoint" }));
    const patch = await request({ type: "diff.get", tabId: opened.tabId }) as { diff: string };
    expect(patch.diff).toContain("diff --git a/app.ts b/app.ts");
    expect(patch.diff).toContain("+export const value = 2;");

    const tabEvents = forTab(events, opened.tabId);
    expect(tabEvents).toContainEqual(expect.objectContaining({ type: "tool_call", name: "edit_file", summary: "app.ts" }));
    expect(tabEvents).toContainEqual(expect.objectContaining({ type: "turn_status", status: "running", summary: "edit_file: app.ts" }));
    expect(tabEvents).toContainEqual(expect.objectContaining({ type: "workspace_changed", diffStat: expect.stringContaining("app.ts") }));
  }, 60_000);

  it("restores the durable human transcript when a session is resumed", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("resume-transcript");
    const opened = await request({ type: "session.open", root }) as { tabId: string; sessionId: string };
    stub.enqueue({ kind: "text", text: "The remembered answer." });
    await request({ type: "turn.send", objective: "Remember this request", tabId: opened.tabId });

    const resumed = await request({ type: "session.resume", root, sessionId: opened.sessionId, tabId: opened.tabId }) as {
      transcript: Array<{ role: string; content: string }>;
    };
    expect(resumed.transcript).toEqual([
      expect.objectContaining({ role: "user", content: "Remember this request" }),
      expect.objectContaining({ role: "assistant", content: "The remembered answer." }),
    ]);
  }, 60_000);

  it("supports a code-only undo and refreshes the desktop working-tree signal", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await gitProject("scoped-undo");
    const opened = await request({ type: "session.open", root, mode: "auto" }) as { tabId: string };
    stub.enqueue({ kind: "tool_call", toolName: "edit_file", input: { path: "app.ts", oldText: "value = 1", newText: "value = 2" } });
    stub.enqueue({ kind: "text", text: "Changed it." });
    await request({ type: "turn.send", objective: "change the value", tabId: opened.tabId });

    const undone = await request({ type: "undo", scope: "code", tabId: opened.tabId }) as { undone: boolean; transcript: unknown[]; diffStat: string };
    expect(undone.undone).toBe(true);
    expect(undone.transcript).toEqual([]);
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("value = 1");
    expect(forTab(events, opened.tabId).at(-1)).toEqual(expect.objectContaining({ type: "workspace_changed" }));
  }, 60_000);

  it("forwards the exact proposed edit before the approval can be answered", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await gitProject("approval-preview");
    const opened = await request({ type: "session.open", root, mode: "build" }) as { tabId: string };
    stub.enqueue({ kind: "tool_call", toolName: "edit_file", input: { path: "app.ts", oldText: "value = 1", newText: "value = 2" } });
    const turn = request({ type: "turn.send", objective: "change the value", tabId: opened.tabId });

    let approval: Extract<IpcEvent, { type: "approval_needed" }> | undefined;
    for (let attempt = 0; attempt < 100 && !approval; attempt += 1) {
      approval = forTab(events, opened.tabId).find((event): event is Extract<IpcEvent, { type: "approval_needed" }> => event.type === "approval_needed");
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(approval).toEqual(expect.objectContaining({
      toolName: "edit_file",
      effect: "workspace",
      preview: { toolName: "edit_file", path: "app.ts", oldText: "value = 1", newText: "value = 2" },
    }));
    await request({ type: "approval.respond", requestId: approval!.requestId, decision: "deny" });
    await turn;
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("value = 1");
  }, 60_000);

  it("reports the tools this mode can actually call", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("inspect-tools"), mode: "plan" }) as { tabId: string };
    const result = await request({ type: "tools.get", tabId: opened.tabId }) as { tools: Array<{ name: string; effect: string; provenance: { kind: string } }> };
    expect(result.tools).toContainEqual(expect.objectContaining({ name: "read_file", effect: "none", provenance: { kind: "built-in" } }));
    expect(result.tools.some((tool) => tool.name === "write_file")).toBe(false);
  }, 60_000);

  it("writes into the project that was opened, on this machine", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("write-local");
    const opened = await request({ type: "session.open", root, mode: "auto" }) as { tabId: string };

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "notes/hello.txt", content: "NOVA_WROTE_THIS" } });
    stub.enqueue({ kind: "text", text: "Created notes/hello.txt." });
    await request({ type: "turn.send", objective: "create notes/hello.txt", tabId: opened.tabId });

    // Read from disk, not from the transcript: the transcript is the claim being checked.
    expect(await fs.readFile(path.join(root, "notes", "hello.txt"), "utf8")).toBe("NOVA_WROTE_THIS");
  }, 60_000);

  it("puts each tab's files in its own project", async () => {
    // Two tabs run at once here, so a workspace shared between them would put one piece of work's
    // files in the other's repository — and the transcript would look correct in both.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const first = await tempProject("write-a");
    const second = await tempProject("write-b");
    const a = await request({ type: "session.open", root: first, mode: "auto" }) as { tabId: string };
    const b = await request({ type: "session.open", root: second, mode: "auto" }) as { tabId: string };

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "a.txt", content: "A" } });
    stub.enqueue({ kind: "text", text: "done" });
    await request({ type: "turn.send", objective: "write a.txt", tabId: a.tabId });
    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "b.txt", content: "B" } });
    stub.enqueue({ kind: "text", text: "done" });
    await request({ type: "turn.send", objective: "write b.txt", tabId: b.tabId });

    expect(await fs.readFile(path.join(first, "a.txt"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(second, "b.txt"), "utf8")).toBe("B");
    await expect(fs.access(path.join(first, "b.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(second, "a.txt"))).rejects.toThrow();
  }, 90_000);

  it("cannot be talked into writing outside the project it was given", async () => {
    // The guard that matters most on a local session: an approved write is a real write, with this
    // user's authority, so the workspace root has to be a boundary rather than a default.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("write-escape");
    const opened = await request({ type: "session.open", root, mode: "auto" }) as { tabId: string };

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "../escaped.txt", content: "OUT" } });
    stub.enqueue({ kind: "text", text: "done" });
    await request({ type: "turn.send", objective: "write outside", tabId: opened.tabId });

    await expect(fs.access(path.join(path.dirname(root), "escaped.txt"))).rejects.toThrow();
  }, 60_000);

  it("refuses a sandbox session rather than quietly writing to this machine", async () => {
    // Sandbox mode is chosen precisely so the work cannot touch the user's files. If the sandbox
    // cannot be created, the only safe answer is to fail: a silent fall back to the local disk
    // would do the one thing the toggle exists to prevent.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: { ...settings(), e2bApiKey: "" } as never });
    const root = await tempProject("sandbox-fallback");
    await expect(request({ type: "session.open", root, mode: "auto", sandbox: true })).rejects.toThrow(/E2B_API_KEY/i);
  }, 60_000);
});

/**
 * Reading a file without leaving the window.
 *
 * The explorer's preview asks the session for the file rather than the disk, which is the whole
 * point: a sandboxed tab is working on a copy that does not exist on this machine, and answering
 * "what is in this file" with a same-named local file would be worse than answering nothing.
 */
describe("reading a file for the explorer", () => {
  it("returns what the file holds, through the session's own workspace", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("read-one");
    await fs.writeFile(path.join(root, "readme.md"), "line one\nline two\n", "utf8");
    const opened = await request({ type: "session.open", root }) as { tabId: string };

    const result = await request({ type: "files.read", path: "readme.md", tabId: opened.tabId }) as { file: { content: string; totalLines: number } };
    expect(result.file.content).toContain("line one");
    expect(result.file.totalLines).toBe(3);
  }, 60_000);

  it("reads from the tab it was asked about, not from whichever is in front", async () => {
    // The failure this prevents is silent: the preview would show a real file with the right name
    // from the wrong project, and nothing on screen would say so.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const first = await tempProject("read-a");
    const second = await tempProject("read-b");
    await fs.writeFile(path.join(first, "same.txt"), "FIRST", "utf8");
    await fs.writeFile(path.join(second, "same.txt"), "SECOND", "utf8");
    const a = await request({ type: "session.open", root: first }) as { tabId: string };
    await request({ type: "session.open", root: second });

    const result = await request({ type: "files.read", path: "same.txt", tabId: a.tabId }) as { file: { content: string } };
    expect(result.file.content).toBe("FIRST");
  }, 60_000);

  it("refuses to read its way out of the project", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("read-escape");
    await fs.writeFile(path.join(path.dirname(root), "outside.txt"), "SECRET", "utf8");
    const opened = await request({ type: "session.open", root }) as { tabId: string };

    await expect(request({ type: "files.read", path: "../outside.txt", tabId: opened.tabId })).rejects.toThrow();
  }, 60_000);
});

/**
 * Switching model rebuilds the session underneath the conversation, which is the point — the new
 * model has to see the history. What must not change is that the tab still works afterwards.
 */
describe("a tab after its model changes", () => {
  it("still accepts a turn", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("model-then-turn") }) as { tabId: string };

    await request({ type: "model.set", model: "claude-fable-5", tabId: opened.tabId });

    stub.enqueue({ kind: "text", text: "still here" });
    await request({ type: "turn.send", objective: "are you there?", tabId: opened.tabId });
    expect(textOf(events, opened.tabId)).toContain("still here");
  }, 60_000);

  it("still accepts a turn when the conversation already had one", async () => {
    // The case that actually broke, and the reason the first test above passed while the app did
    // not: a session is only written to disk once it has a turn in it. Switching model then loads
    // that record and asks the daemon to open it — but the old session is still live, so the daemon
    // returns it instead of building anything, and the release that follows disposes the very
    // session the tab has just been pointed at. Every later request answers "Session is not active
    // in this daemon", which is what a person sees as the tab silently dying after one exchange.
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("model-after-turn") }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "first answer" });
    await request({ type: "turn.send", objective: "hello", tabId: opened.tabId });

    await request({ type: "model.set", model: "claude-fable-5", tabId: opened.tabId });

    stub.enqueue({ kind: "text", text: "second answer" });
    await request({ type: "turn.send", objective: "how are you?", tabId: opened.tabId });
    expect(textOf(events, opened.tabId)).toContain("second answer");
  }, 60_000);

  it("survives a mode change after a turn, which fails the same way", async () => {
    const { request, events } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("mode-after-turn") }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "first answer" });
    await request({ type: "turn.send", objective: "hello", tabId: opened.tabId });

    await request({ type: "mode.set", mode: "plan", tabId: opened.tabId });

    stub.enqueue({ kind: "text", text: "after the mode change" });
    await request({ type: "turn.send", objective: "and now?", tabId: opened.tabId });
    expect(textOf(events, opened.tabId)).toContain("after the mode change");
  }, 60_000);

  it("keeps the conversation across the switch rather than starting fresh", async () => {
    // The whole reason the session is rebuilt from its record: the new model has to see what was
    // already said. A rebuild that quietly dropped the history would look like it worked.
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const root = await tempProject("model-keeps-history");
    const opened = await request({ type: "session.open", root }) as { tabId: string };

    stub.enqueue({ kind: "text", text: "remembered answer" });
    await request({ type: "turn.send", objective: "remember this", tabId: opened.tabId });
    await request({ type: "model.set", model: "claude-fable-5", tabId: opened.tabId });

    const listed = await request({ type: "session.list", root }) as Array<{ id: string }>;
    expect(listed.length).toBe(1);
  }, 60_000);

  it("reports the session it rebuilt, so the window is not left holding the old one", async () => {
    const { request } = bootHost();
    await request({ type: "settings.set", settings: settings() });
    const opened = await request({ type: "session.open", root: await tempProject("model-session-id") }) as { tabId: string; sessionId: string };

    const after = await request({ type: "model.set", model: "claude-fable-5", tabId: opened.tabId }) as { sessionId?: string };
    expect(after.sessionId).toBeTruthy();
  }, 60_000);
});
