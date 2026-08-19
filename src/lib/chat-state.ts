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

/**
 * One thing the agent did, as a single entry that resolves — not two lines.
 *
 * Tool calls and their results used to be appended straight into the transcript, two rows each, so
 * a turn that read four files and ran the tests put ten machine lines between one sentence of the
 * answer and the next. The conversation is what a person is reading; the tool log is what they
 * check when something looks wrong. Splitting them is the whole point: a call arrives `running` and
 * the matching result settles the same entry rather than adding another.
 */
export type ActivityEntry = {
  /** The tool call id, so the result can find the call it belongs to. */
  id: string;
  name: string;
  summary?: string;
  status: "running" | "ok" | "failed";
  preview?: string;
};

export type ChatState = {
  /** The conversation: what was asked, what was answered, and what the session said about itself. */
  messages: ChatMessage[];
  /** What the agent did, in order. Kept out of `messages` so the conversation stays readable. */
  activity: ActivityEntry[];
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
  /**
   * How the last turn ended.
   *
   * Kept because "what should I do now" has a different answer after a cancelled turn than after a
   * failed one, and the transcript cannot be asked: a status with no summary writes no message at
   * all, so by the time the suggestions are computed the distinction has been thrown away.
   */
  lastStatus?: string;
  /** Turns that have ended, whatever they ended as. What "this is your first session" is read from. */
  turns?: number;
};

/** The id the in-progress answer is held under, so successive deltas rewrite one message. */
export const STREAMING_ID = "streaming";

export function initialChatState(): ChatState {
  return { messages: [], activity: [], streaming: "", approval: null, costReport: "No turns yet.", error: null };
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
        activity: [...state.activity, {
          id: event.toolCallId,
          name: event.name,
          ...(event.summary ? { summary: event.summary } : {}),
          status: "running",
        }],
      };

    case "tool_result": {
      // Settles the call it belongs to. A result whose call was never seen still gets an entry:
      // dropping it would hide work that happened, which is the one thing this panel exists to show.
      const index = state.activity.findIndex((entry) => entry.id === event.toolCallId);
      const settled: ActivityEntry = {
        id: event.toolCallId,
        name: event.name,
        ...(index >= 0 && state.activity[index].summary ? { summary: state.activity[index].summary } : {}),
        status: event.ok ? "ok" : "failed",
        ...(event.preview ? { preview: event.preview } : {}),
      };
      if (index < 0) return { ...state, activity: [...state.activity, settled] };
      const activity = [...state.activity];
      activity[index] = settled;
      return { ...state, activity };
    }

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
      // How the turn ended, and that it ended, recorded before anything is done with its text: the
      // suggestions read both, and a status carrying no summary writes no message, so this is the
      // only place either fact exists.
      const ended: ChatState = { ...state, lastStatus: event.status, turns: (state.turns ?? 0) + 1 };
      // The turn is over, so whatever was streaming is now final: it is re-filed under a stable id
      // so the next turn's deltas cannot append to it. Text already produced survives a cancelled
      // or failed turn — losing a half-written answer because it was interrupted is the worst
      // possible reading of "stop".
      if (ended.streaming) {
        // Settled *in place* — only the id changes. Lifting it out and re-appending would move the
        // answer to the bottom of the transcript on the very last event of the turn: text streamed
        // before a tool call would jump below it, so a turn that read a file and then explained
        // what it found would read as though it explained first and looked afterwards.
        const settledId = `assistant-${now()}`;
        let replaced = false;
        const messages = ended.messages.map((message) => {
          if (message.id !== STREAMING_ID) return message;
          replaced = true;
          return { ...message, id: settledId };
        });
        return {
          ...ended,
          streaming: "",
          messages: replaced
            ? messages
            : [...messages, { id: settledId, role: "assistant" as const, content: ended.streaming }],
        };
      }
      // Nothing was streamed. A summary is worth saying — "cancelled", "budget spent" — but a bare
      // status with no summary is not a transcript entry.
      if (event.summary) {
        return { ...ended, messages: [...ended.messages, { id: `status-${now()}`, role: "system", content: event.summary }] };
      }
      return ended;
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
