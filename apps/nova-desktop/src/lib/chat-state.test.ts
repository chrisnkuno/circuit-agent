import { describe, expect, it } from "vitest";
import {
  appendUserMessage,
  applyChatEvent,
  applyChatEvents,
  initialChatState,
  STREAMING_ID,
  type ChatState,
} from "./chat-state";
import type { IpcEvent } from "./settings";

/** A fixed clock, so ids are predictable and two events in one batch cannot collide by timing. */
let tick = 0;
const clock = () => ++tick;
const fresh = (): ChatState => { tick = 0; return initialChatState(); };

const delta = (text: string): IpcEvent => ({ type: "assistant_delta", text });
const status = (state: string, summary?: string): IpcEvent =>
  ({ type: "turn_status", status: state, ...(summary ? { summary } : {}) }) as IpcEvent;

describe("a streamed answer", () => {
  it("coalesces successive deltas into one message rather than one per token", () => {
    const state = applyChatEvents(fresh(), [delta("Hel"), delta("lo "), delta("world")], clock);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Hello world");
    expect(state.messages[0].role).toBe("assistant");
  });

  it("keeps appending to the streaming message even after a tool call lands mid-answer", () => {
    // The regression this guards: reading the buffer back off the *last* message. A tool call
    // appends after it, so the next delta would start a second answer bubble.
    const state = applyChatEvents(fresh(), [
      delta("Looking… "),
      { type: "tool_call", toolCallId: "t1", name: "read_file", summary: "app.ts" } as IpcEvent,
      delta("found it."),
    ], clock);
    const assistants = state.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Looking… found it.");
    // …and the tool line is still there, after the answer it interrupted.
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
  });

  it("settles into a stable id when the turn ends, so the next turn starts a new bubble", () => {
    let state = applyChatEvents(fresh(), [delta("first answer")], clock);
    expect(state.messages[0].id).toBe(STREAMING_ID);
    state = applyChatEvent(state, status("completed"), clock);
    expect(state.messages[0].id).not.toBe(STREAMING_ID);
    expect(state.streaming).toBe("");

    state = applyChatEvents(state, [delta("second answer")], clock);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].content).toBe("second answer");
  });

  it("settles the answer where it was said, not at the bottom of the transcript", () => {
    // Found by simulating a real turn. The answer used to be lifted out and re-appended when the
    // turn completed, so text streamed *before* a tool call jumped below it — a turn that read a
    // file and then explained what it found read as though it explained first and looked after.
    let state = applyChatEvents(fresh(), [
      delta("Reading the file first."),
      { type: "tool_call", toolCallId: "c1", name: "read_file" } as IpcEvent,
      { type: "tool_result", toolCallId: "c1", name: "read_file", ok: true } as IpcEvent,
    ], clock);
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
    state = applyChatEvent(state, status("completed"), clock);
    // Same order after settling — only the id changed.
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
    expect(state.messages[0].id).not.toBe(STREAMING_ID);
    expect(state.messages[0].content).toBe("Reading the file first.");
  });

  it("keeps text already produced when a turn is cancelled or fails", () => {
    // Losing a half-written answer because the user pressed Stop is the worst reading of "stop".
    for (const ending of ["cancelled", "failed"]) {
      let state = applyChatEvents(fresh(), [delta("partial thought")], clock);
      state = applyChatEvent(state, status(ending), clock);
      expect(state.messages.at(-1)?.content, ending).toBe("partial thought");
    }
  });

  it("does not settle anything while the turn is still running", () => {
    const streaming = applyChatEvents(fresh(), [delta("mid")], clock);
    const after = applyChatEvent(streaming, status("running"), clock);
    expect(after).toBe(streaming); // same object: nothing to repaint
    expect(after.messages[0].id).toBe(STREAMING_ID);
  });
});

describe("tool calls and their results", () => {
  it("shows a call with its summary, and omits the separator when there is none", () => {
    const withSummary = applyChatEvent(fresh(), { type: "tool_call", toolCallId: "a", name: "read_file", summary: "app.ts" } as IpcEvent, clock);
    expect(withSummary.messages[0].content).toBe("→ read_file: app.ts");
    const bare = applyChatEvent(fresh(), { type: "tool_call", toolCallId: "b", name: "list_files" } as IpcEvent, clock);
    expect(bare.messages[0].content).toBe("→ list_files");
  });

  it("distinguishes a failed tool from a successful one", () => {
    const ok = applyChatEvent(fresh(), { type: "tool_result", toolCallId: "a", name: "run", ok: true } as IpcEvent, clock);
    const bad = applyChatEvent(fresh(), { type: "tool_result", toolCallId: "a", name: "run", ok: false } as IpcEvent, clock);
    expect(ok.messages[0].content.startsWith("✓")).toBe(true);
    expect(bad.messages[0].content.startsWith("✗")).toBe(true);
  });

  it("gives a call and its result different ids, since both are on screen at once", () => {
    const state = applyChatEvents(fresh(), [
      { type: "tool_call", toolCallId: "same", name: "run" } as IpcEvent,
      { type: "tool_result", toolCallId: "same", name: "run", ok: true } as IpcEvent,
    ], clock);
    const ids = state.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a preview on its own line when the result has one", () => {
    const state = applyChatEvent(fresh(), { type: "tool_result", toolCallId: "a", name: "run", ok: true, preview: "exit 0" } as IpcEvent, clock);
    expect(state.messages[0].content).toBe("✓ run\nexit 0");
  });
});

describe("approvals", () => {
  it("raises the request so the modal can ask", () => {
    const state = applyChatEvent(fresh(), {
      type: "approval_needed", requestId: "r1", toolName: "write_file", summary: "write src/app.ts",
    } as IpcEvent, clock);
    expect(state.approval).toEqual({ requestId: "r1", toolName: "write_file", summary: "write src/app.ts" });
  });

  it("replaces a pending request rather than queuing behind it", () => {
    // Only one approval can be answered at a time; the newest is the one the engine is waiting on.
    let state = applyChatEvent(fresh(), { type: "approval_needed", requestId: "r1", toolName: "a", summary: "s" } as IpcEvent, clock);
    state = applyChatEvent(state, { type: "approval_needed", requestId: "r2", toolName: "b", summary: "t" } as IpcEvent, clock);
    expect(state.approval?.requestId).toBe("r2");
  });

  it("does not add a transcript message — an approval is a question, not output", () => {
    const state = applyChatEvent(fresh(), { type: "approval_needed", requestId: "r", toolName: "a", summary: "s" } as IpcEvent, clock);
    expect(state.messages).toEqual([]);
  });
});

describe("cost and errors", () => {
  it("records the report and the running total", () => {
    const state = applyChatEvent(fresh(), {
      type: "cost", report: "2 turns", displayTotal: "$0.04", budgetFraction: 0.25,
    } as IpcEvent, clock);
    expect(state.costReport).toBe("2 turns");
    expect(state.displayTotal).toBe("$0.04");
    expect(state.budgetFraction).toBe(0.25);
  });

  it("leaves a previously known total alone when an update omits it", () => {
    let state = applyChatEvent(fresh(), { type: "cost", report: "r", displayTotal: "$1.00" } as IpcEvent, clock);
    state = applyChatEvent(state, { type: "cost", report: "r2" } as IpcEvent, clock);
    expect(state.displayTotal).toBe("$1.00");
  });

  it("surfaces an error without destroying the transcript that led to it", () => {
    let state = applyChatEvents(fresh(), [delta("some work")], clock);
    state = applyChatEvent(state, { type: "error", message: "provider refused" } as IpcEvent, clock);
    expect(state.error).toBe("provider refused");
    expect(state.messages[0].content).toBe("some work");
  });
});

describe("turn status without a streamed answer", () => {
  it("records a summary as a system line", () => {
    const state = applyChatEvent(fresh(), status("cancelled", "Stopped before the first token."), clock);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("system");
    expect(state.messages[0].content).toBe("Stopped before the first token.");
  });

  it("adds nothing for a bare status with no summary and nothing streamed", () => {
    const before = fresh();
    expect(applyChatEvent(before, status("completed"), clock)).toBe(before);
  });
});

describe("the user's own messages", () => {
  it("appends the message and clears any previous error", () => {
    let state = applyChatEvent(fresh(), { type: "error", message: "old failure" } as IpcEvent, clock);
    state = appendUserMessage(state, "try again", clock);
    expect(state.error).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "user", content: "try again" });
  });
});

describe("the reduction itself", () => {
  it("never mutates the state it was given", () => {
    const before = fresh();
    const snapshot = JSON.stringify(before);
    applyChatEvents(before, [
      delta("x"),
      { type: "tool_call", toolCallId: "t", name: "run" } as IpcEvent,
      { type: "error", message: "e" } as IpcEvent,
      status("completed"),
    ], clock);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("ignores an event type it does not know, rather than throwing", () => {
    const before = fresh();
    expect(applyChatEvent(before, { type: "something_new" } as unknown as IpcEvent, clock)).toBe(before);
  });

  it("gives every message a unique key across a whole realistic turn", () => {
    // Duplicate keys are how React silently reuses the wrong row, which shows up as a tool result
    // rendering into an answer bubble.
    const state = applyChatEvents(fresh(), [
      delta("Reading the file. "),
      { type: "tool_call", toolCallId: "c1", name: "read_file", summary: "a.ts" } as IpcEvent,
      { type: "tool_result", toolCallId: "c1", name: "read_file", ok: true, preview: "40 lines" } as IpcEvent,
      delta("Now editing. "),
      { type: "tool_call", toolCallId: "c2", name: "edit_file", summary: "a.ts" } as IpcEvent,
      { type: "tool_result", toolCallId: "c2", name: "edit_file", ok: false, preview: "no match" } as IpcEvent,
      delta("That failed."),
      status("completed"),
    ], clock);
    const ids = state.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    // And the whole answer is one bubble, despite four tool lines interleaved through it.
    const assistants = state.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Reading the file. Now editing. That failed.");
  });
});
