import type { TurnCostPoint } from "./cost-chart";
import type { IpcEvent } from "./settings";

/**
 * What a stream of sidecar events does to the transcript — as a pure reduction.
 *
 * This was a `useEffect` calling six `setMessages` closures inside the Chat screen, which made the
 * most important behaviour in the app the only behaviour that could not be tested: whether a
 * streamed answer coalesces into one message, whether a failed tool is distinguishable from a
 * successful one, whether an interrupted turn loses the text it had already produced. All of that
 * was reachable only by rendering a component, and this app has no DOM harness.
 *
 * `transcript.ts` in this same folder already states the rule — "kept as pure functions rather than
 * done inside the component so it can be tested without a DOM" — and this is the part that most
 * needed it. The screen now owns scrolling and focus; the transcript's *content* is decided here.
 */

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
};

export type ApprovalState = { requestId: string; toolName: string; summary: string };

export type ChatState = {
  messages: ChatMessage[];
  /**
   * Text accumulated for the answer currently streaming.
   *
   * Held apart from `messages` rather than read back off the last one, because the last message is
   * not reliably the streaming one: a tool call landing mid-answer appends after it.
   */
  streaming: string;
  approval: ApprovalState | null;
  costReport: string;
  displayTotal?: string;
  budgetFraction?: number;
  /** Per-turn spend, for the charts. Empty until a turn has finished. */
  costTurns?: TurnCostPoint[];
  error: string | null;
};

/** The id the in-progress answer is held under, so successive deltas rewrite one message. */
export const STREAMING_ID = "streaming";

export function initialChatState(): ChatState {
  return { messages: [], streaming: "", approval: null, costReport: "No turns yet.", error: null };
}

/**
 * Folds one event into the transcript.
 *
 * Returns the same object when an event changes nothing, so a caller can skip a render — several
 * event types are informational and a stream of them should not repaint the transcript.
 */
export function applyChatEvent(state: ChatState, event: IpcEvent, now: () => number = Date.now): ChatState {
  switch (event.type) {
    case "assistant_delta": {
      const streaming = state.streaming + event.text;
      const messages = [...state.messages];
      const index = messages.findIndex((message) => message.id === STREAMING_ID);
      if (index >= 0) messages[index] = { ...messages[index], content: streaming };
      else messages.push({ id: STREAMING_ID, role: "assistant", content: streaming });
      return { ...state, streaming, messages };
    }

    case "tool_call":
      return {
        ...state,
        messages: [...state.messages, {
          id: event.toolCallId,
          role: "tool",
          content: `→ ${event.name}${event.summary ? `: ${event.summary}` : ""}`,
        }],
      };

    case "tool_result":
      return {
        ...state,
        messages: [...state.messages, {
          // Distinct from the call's own id: both are in the list at once, and React needs them
          // to be different or it reuses one row for both.
          id: `${event.toolCallId}-result`,
          role: "tool",
          content: `${event.ok ? "✓" : "✗"} ${event.name}${event.preview ? `\n${event.preview}` : ""}`,
        }],
      };

    case "approval_needed":
      return {
        ...state,
        approval: { requestId: event.requestId, toolName: event.toolName, summary: event.summary },
      };

    case "cost":
      return {
        ...state,
        costReport: event.report,
        ...(event.displayTotal === undefined ? {} : { displayTotal: event.displayTotal }),
        ...(event.budgetFraction === undefined ? {} : { budgetFraction: event.budgetFraction }),
      };

    case "error":
      return { ...state, error: event.message };

    case "turn_status": {
      if (event.status === "running") return state;
      // The turn is over, so whatever was streaming is now final: it is re-filed under a stable id
      // so the next turn's deltas cannot append to it. Text already produced survives a cancelled
      // or failed turn — losing a half-written answer because it was interrupted is the worst
      // possible reading of "stop".
      if (state.streaming) {
        // Settled *in place* — only the id changes. Lifting it out and re-appending would move the
        // answer to the bottom of the transcript on the very last event of the turn: text streamed
        // before a tool call would jump below it, so a turn that read a file and then explained
        // what it found would read as though it explained first and looked afterwards.
        const settledId = `assistant-${now()}`;
        let replaced = false;
        const messages = state.messages.map((message) => {
          if (message.id !== STREAMING_ID) return message;
          replaced = true;
          return { ...message, id: settledId };
        });
        return {
          ...state,
          streaming: "",
          messages: replaced
            ? messages
            : [...messages, { id: settledId, role: "assistant" as const, content: state.streaming }],
        };
      }
      // Nothing was streamed. A summary is worth saying — "cancelled", "budget spent" — but a bare
      // status with no summary is not a transcript entry.
      if (event.summary) {
        return { ...state, messages: [...state.messages, { id: `status-${now()}`, role: "system", content: event.summary }] };
      }
      return state;
    }

    default:
      return state;
  }
}

/** Folds a whole batch, which is how the screen receives them. */
export function applyChatEvents(state: ChatState, events: readonly IpcEvent[], now: () => number = Date.now): ChatState {
  return events.reduce((current, event) => applyChatEvent(current, event, now), state);
}

/** The user's own message, appended when they send rather than echoed back by the sidecar. */
export function appendUserMessage(state: ChatState, text: string, now: () => number = Date.now): ChatState {
  return { ...state, error: null, messages: [...state.messages, { id: `user-${now()}`, role: "user", content: text }] };
}
