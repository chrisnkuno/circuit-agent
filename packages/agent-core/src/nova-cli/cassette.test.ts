import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { NovaAgent } from "./agent";
import { LocalWorkspace } from "./backends";
import {
  CASSETTE_VERSION,
  CassetteError,
  FaultInjectingTurnProvider,
  RecordingTurnProvider,
  ReplayTurnProvider,
  parseCassette,
  requestDigest,
  serializeCassette,
} from "./cassette";

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };

function scripted(turns: Array<Partial<AgentModelTurn>>): AgentTurnProvider & { calls: number } {
  let index = 0;
  return {
    get calls() { return index; },
    async complete() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return { responseId: `r${index}`, model: "nova-test", finishReason: "stop", content: "Done.", toolCalls: [], usage, ...turn } as AgentModelTurn;
    },
  };
}

const baseRequest: AgentModelRequest = {
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }],
  tools: [{ name: "read_file", description: "", inputSchema: {} }],
  maxOutputTokens: 1_000,
  safetyIdentifier: "id-1",
};

describe("request fingerprinting", () => {
  it("is stable across things that do not change what the model was asked", () => {
    // The budget shrinks as a run spends and the safety identifier embeds a session id. Folding
    // either into the digest would make every cassette single-use for no gain in fidelity.
    const digest = requestDigest(baseRequest);
    expect(requestDigest({ ...baseRequest, maxOutputTokens: 42 } as AgentModelRequest)).toBe(digest);
    expect(requestDigest({ ...baseRequest, safetyIdentifier: "other" } as AgentModelRequest)).toBe(digest);
    // Tool order is presentation, not meaning.
    expect(requestDigest({ ...baseRequest, tools: [...baseRequest.tools].reverse() })).toBe(digest);
  });

  it("changes when anything that does determine the answer changes", () => {
    const digest = requestDigest(baseRequest);
    expect(requestDigest({ ...baseRequest, messages: [{ role: "system", content: "sys" }, { role: "user", content: "goodbye" }] })).not.toBe(digest);
    expect(requestDigest({ ...baseRequest, messages: [{ role: "system", content: "CHANGED" }, { role: "user", content: "hello" }] })).not.toBe(digest);
    expect(requestDigest({ ...baseRequest, tools: [] })).not.toBe(digest);
  });

  it("ignores tool-call ids, which are regenerated every run", () => {
    const withId = (id: string): AgentModelRequest => ({
      ...baseRequest,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: { path: "a.ts" } }] },
        { role: "tool", content: "contents", toolCallId: id, name: "read_file" },
      ],
    });
    expect(requestDigest(withId("call_abc"))).toBe(requestDigest(withId("call_xyz")));
  });
});

describe("record and replay", () => {
  it("replays a recorded exchange exactly", async () => {
    const live = scripted([{ content: "first" }, { content: "second" }]);
    const recorder = new RecordingTurnProvider(live);
    const one = await recorder.complete(baseRequest);
    const two = await recorder.complete({ ...baseRequest, messages: [...baseRequest.messages, { role: "user", content: "again" }] });

    const replay = new ReplayTurnProvider(parseCassette(serializeCassette(recorder.cassette())));
    expect(await replay.complete(baseRequest)).toEqual(one);
    expect(await replay.complete({ ...baseRequest, messages: [...baseRequest.messages, { role: "user", content: "again" }] })).toEqual(two);
    expect(replay.exhausted).toBe(true);
  });

  it("refuses to answer a request it was not recorded for", () => {
    // The failure this exists to prevent: a test that keeps passing after the prompt changed,
    // because the cassette answered by position and nobody checked what the question was.
    const recorder = new RecordingTurnProvider(scripted([{ content: "hi" }]));
    return recorder.complete(baseRequest).then(async () => {
      const replay = new ReplayTurnProvider(recorder.cassette());
      await expect(replay.complete({ ...baseRequest, messages: [{ role: "user", content: "different" }] }))
        .rejects.toThrow(/does not match the recording.*re-record/s);
    });
  });

  it("can be told not to check, but only deliberately", async () => {
    const recorder = new RecordingTurnProvider(scripted([{ content: "hi" }]));
    await recorder.complete(baseRequest);
    const loose = new ReplayTurnProvider(recorder.cassette(), { strict: false });
    await expect(loose.complete({ ...baseRequest, messages: [{ role: "user", content: "different" }] })).resolves.toMatchObject({ content: "hi" });
  });

  it("errors rather than hanging when the run wants more turns than were recorded", async () => {
    const recorder = new RecordingTurnProvider(scripted([{ content: "hi" }]));
    await recorder.complete(baseRequest);
    const replay = new ReplayTurnProvider(recorder.cassette());
    await replay.complete(baseRequest);
    await expect(replay.complete(baseRequest)).rejects.toThrow(/asked for turn 2, but the cassette holds 1/);
  });

  it("serializes deterministically, so an unchanged re-recording is an empty diff", async () => {
    const record = async () => {
      const recorder = new RecordingTurnProvider(scripted([{ content: "stable" }]));
      await recorder.complete(baseRequest);
      return serializeCassette(recorder.cassette());
    };
    expect(await record()).toBe(await record());
    // The timestamp is the one volatile field, and it is opt-in for exactly this reason.
    const recorder = new RecordingTurnProvider(scripted([{ content: "stable" }]));
    await recorder.complete(baseRequest);
    expect(serializeCassette(recorder.cassette("2026-08-10T00:00:00.000Z"))).toContain("recordedAt");
    expect(await record()).not.toContain("recordedAt");
  });

  it("rejects a malformed or out-of-order cassette at load", () => {
    expect(() => parseCassette("{")).toThrow(/not valid JSON/);
    expect(() => parseCassette(JSON.stringify({ cassette: 99, entries: [] }))).toThrow(/Unsupported cassette version/);
    expect(() => parseCassette(JSON.stringify({ cassette: CASSETTE_VERSION }))).toThrow(/no entries/);
    // Out of order would replay answers against the wrong requests.
    const swapped = { cassette: CASSETTE_VERSION, model: "m", entries: [{ index: 1, requestDigest: "d", turn: {} }] };
    expect(() => parseCassette(JSON.stringify(swapped))).toThrow(/out of order/);
    expect(() => new ReplayTurnProvider({ cassette: 2 as never, model: "m", entries: [] })).toThrow(CassetteError);
  });
});

describe("a whole agent turn, recorded and replayed", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-cassette-"));
    await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const agentWith = (model: AgentTurnProvider) => new NovaAgent({
    root, model, prices, mode: "build",
    approve: async () => "allow",
    workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" })),
    git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
  });

  it("reproduces the same tool calls and the same result without the model", async () => {
    const live = scripted([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "app.ts" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c2", name: "edit_file", arguments: { path: "app.ts", oldText: "3000", newText: "8080" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm test" } }] },
      { finishReason: "stop", content: "Port is now 8080." },
    ]);
    const recorder = new RecordingTurnProvider(live);
    const recorded = await agentWith(recorder).send("change the port to 8080");
    expect(recorded.status).toBe("completed");
    const tape = parseCassette(serializeCassette(recorder.cassette()));
    // A passing targeted test now closes a focused change instead of buying a fifth model turn
    // merely to ask for a generic assembled-program check that this constant change cannot have.
    expect(tape.entries).toHaveLength(4);

    // A fresh workspace, so the replayed run really re-does the work rather than observing it.
    await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");
    const replay = new ReplayTurnProvider(tape);
    const replayed = await agentWith(replay).send("change the port to 8080");

    expect(replayed.status).toBe(recorded.status);
    expect(replayed.summary).toBe(recorded.summary);
    expect(replayed.toolCallsExecuted).toBe(recorded.toolCallsExecuted);
    expect(replayed.usage).toEqual(recorded.usage);
    expect(replay.exhausted).toBe(true);
    // And the side effect happened again, identically.
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("8080");
  });

  it("produces the golden event stream, in order", async () => {
    // The agent's observable behaviour, pinned. A change to which tools run, in what order, or
    // what the run concludes shows up here as a diff someone has to justify — which is the point
    // of recording sessions at all.
    const live = scripted([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "app.ts" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c2", name: "edit_file", arguments: { path: "app.ts", oldText: "3000", newText: "8080" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm test" } }] },
      { finishReason: "stop", content: "Port is now 8080." },
    ]);
    const recorder = new RecordingTurnProvider(live);
    await agentWith(recorder).send("change the port to 8080");
    await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");

    const events: string[] = [];
    const replayed = new NovaAgent({
      root, model: new ReplayTurnProvider(parseCassette(serializeCassette(recorder.cassette()))), prices, mode: "build",
      approve: async () => "allow",
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" })),
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
      onEvent: (event) => {
        if (event.type !== "runtime") return void events.push(event.type);
        const runtime = event.event;
        if (runtime.type === "assistant_delta") return;
        events.push(runtime.type === "tool_call" ? `tool_call:${runtime.toolName}` : runtime.type);
      },
    });
    const result = await replayed.send("change the port to 8080");

    expect(events).toEqual([
      "model_turn", "tool_call:read_file", "tool_result",
      "model_turn", "tool_call:edit_file", "tool_result",
      "model_turn", "tool_call:run_command", "tool_result",
      "model_turn", "runtime_stop",
    ]);
    expect(result.status).toBe("completed");
  });

  it("survives a provider that dies mid-run, after real edits have landed", async () => {
    // The state that matters is the one left behind: the edit from turn 2 is on disk, and the
    // failure has to reach the caller as an error rather than a completed-looking turn.
    const live = scripted([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: { path: "app.ts", oldText: "3000", newText: "8080" } }] },
      { finishReason: "stop", content: "unreachable" },
    ]);
    // All three attempts fail, proving the retry is bounded while preserving the edit that landed
    // before the provider outage. A single injected drop now recovers by design.
    const faulty = new FaultInjectingTurnProvider(live, [
      { at: 2, kind: "throw", message: "socket hang up" },
      { at: 3, kind: "throw", message: "socket hang up" },
      { at: 4, kind: "throw", message: "socket hang up" },
    ]);
    await expect(agentWith(faulty).send("change the port")).rejects.toThrow(/socket hang up/);
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("8080");
  });

  it("repairs one malformed turn without following it into a loop", async () => {
    // finish_reason says "tool_calls" and there are none. The runtime asks for one corrected turn,
    // and the bounded correction cap still prevents an endless malformed-response loop.
    const faulty = new FaultInjectingTurnProvider(scripted([{ finishReason: "stop", content: "fine" }]), [{ at: 1, kind: "malformed" }]);
    const result = await agentWith(faulty).send("do something");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("fine");
  });

  it("reports a refusal as a refusal, not as an empty success", async () => {
    const faulty = new FaultInjectingTurnProvider(scripted([{ finishReason: "stop", content: "" }]), [{ at: 1, kind: "refusal", refusal: "I can't help with that." }]);
    const result = await agentWith(faulty).send("do something disallowed");
    expect(result.status).toBe("blocked");
    expect(result.summary).toBe("I can't help with that.");
  });

  it("catches a changed system prompt instead of replaying the old answer", async () => {
    const recorder = new RecordingTurnProvider(scripted([{ finishReason: "stop", content: "Understood." }]));
    await agentWith(recorder).send("what does this do?");
    const tape = recorder.cassette();

    // An instructions file the recording never saw changes the system prompt, which is exactly the
    // drift a positional cassette would replay straight through.
    await fs.writeFile(path.join(root, "NOVA.md"), "Always use tabs.\n");
    await expect(agentWith(new ReplayTurnProvider(tape)).send("what does this do?")).rejects.toThrow(/does not match the recording/);
  });
});
