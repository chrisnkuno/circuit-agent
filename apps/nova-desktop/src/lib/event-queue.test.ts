import { describe, expect, it } from "vitest";
import { applyChatEvents, initialChatState } from "./chat-state";
import type { IpcEvent } from "./settings";

/**
 * The sidecar event queue, as the app actually drains it.
 *
 * The transcript reducer was always correct; the *delivery* was not. Events arrived into a React
 * state array which the Chat screen drained in an effect and then cleared, and that shape had two
 * defects that both showed up as garbled output rather than as an error:
 *
 * - **Duplicated tokens.** React StrictMode double-invokes effects on mount. Both invocations read
 *   the same captured array, so every delta was folded in twice and "Hello" rendered "HelloHello".
 * - **Dropped tokens.** The drain cleared the entire buffer unconditionally, so an event that
 *   arrived between the effect reading the array and the clear landing was silently discarded.
 *
 * The fix is a mutable queue drained with `splice(0)` — an atomic take. These tests model the
 * queue and the drain directly, because the bug lived in that contract and not in either component.
 */

/** The App side: a queue events are pushed onto, and an atomic take. */
function createQueue() {
  const queue: IpcEvent[] = [];
  return {
    push: (event: IpcEvent) => queue.push(event),
    /** Exactly what `takeEvents` does in App.tsx. */
    take: () => queue.splice(0),
    get length() { return queue.length; },
  };
}

const delta = (text: string): IpcEvent => ({ type: "assistant_delta", text });

/** The Chat side: take, then fold. Order matters — taking first is what makes it safe to repeat. */
function drainInto(state: ReturnType<typeof initialChatState>, queue: ReturnType<typeof createQueue>) {
  const pending = queue.take();
  return pending.length === 0 ? state : applyChatEvents(state, pending);
}

describe("draining the sidecar event queue", () => {
  it("folds each event exactly once", () => {
    const queue = createQueue();
    queue.push(delta("Hel"));
    queue.push(delta("lo"));
    expect(drainInto(initialChatState(), queue).streaming).toBe("Hello");
  });

  /**
   * The duplication bug, directly. Under StrictMode the effect body runs twice on mount; with the
   * old clear-the-buffer shape both runs saw the same events and appended them twice.
   */
  it("is safe to drain twice, which is what StrictMode does on mount", () => {
    const queue = createQueue();
    queue.push(delta("Hello"));
    let state = initialChatState();
    state = drainInto(state, queue);
    state = drainInto(state, queue); // StrictMode's second invocation
    expect(state.streaming).toBe("Hello");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Hello");
  });

  it("is safe to drain any number of times, with no events in flight", () => {
    const queue = createQueue();
    queue.push(delta("x"));
    let state = initialChatState();
    for (let attempt = 0; attempt < 5; attempt += 1) state = drainInto(state, queue);
    expect(state.streaming).toBe("x");
  });

  /**
   * The loss bug, directly. An event arriving mid-drain must survive to the next drain; the old
   * shape cleared it along with the ones that had actually been read.
   */
  it("keeps an event that arrives between the take and the next drain", () => {
    const queue = createQueue();
    queue.push(delta("first "));
    let state = initialChatState();
    state = drainInto(state, queue);
    queue.push(delta("second")); // arrives after the take, before the next drain
    state = drainInto(state, queue);
    expect(state.streaming).toBe("first second");
  });

  it("empties the queue as it takes, so nothing accumulates", () => {
    const queue = createQueue();
    queue.push(delta("a"));
    queue.push(delta("b"));
    drainInto(initialChatState(), queue);
    expect(queue.length).toBe(0);
  });

  it("preserves order across drains, however the events are batched", () => {
    // Whatever the split, the answer reads the same — a delta boundary is not a semantic boundary.
    for (const batches of [[["a", "b", "c"]], [["a"], ["b", "c"]], [["a"], ["b"], ["c"]]]) {
      const queue = createQueue();
      let state = initialChatState();
      for (const batch of batches) {
        for (const text of batch) queue.push(delta(text));
        state = drainInto(state, queue);
      }
      expect(state.streaming, JSON.stringify(batches)).toBe("abc");
    }
  });

  it("does not duplicate across a settled turn either", () => {
    const queue = createQueue();
    queue.push(delta("done"));
    queue.push({ type: "turn_status", status: "completed" } as IpcEvent);
    let state = initialChatState();
    state = drainInto(state, queue);
    state = drainInto(state, queue);
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(state.messages[0].content).toBe("done");
  });
});
