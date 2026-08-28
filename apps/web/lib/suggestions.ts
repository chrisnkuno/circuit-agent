/**
 * What to offer the person next.
 *
 * A command center knows more about the state of the work than the person looking at it does, so
 * it should say what the useful next move is rather than leaving an empty box. The rules are
 * ordered by urgency: something that is stuck outranks something that is merely finished, which
 * outranks a cold start.
 *
 * Kept pure so "what would this offer in that situation" is a question with a testable answer.
 */

export type Suggestion = {
  /** What the chip says. Short enough to read without stopping. */
  label: string;
  /** What lands in the composer when it is taken. Empty means the chip is an action, not a prompt. */
  prompt: string;
  kind: "unblock" | "inspect" | "continue" | "start";
  /** The task a chip acts on, when it opens one rather than filling the composer. */
  taskId?: string;
};

export type SuggestionState = {
  hasWorkspace: boolean;
  draft: string;
  /** Tasks the workspace knows about, newest first. */
  tasks: { id: string; title: string; status: string; blockedReason?: string }[];
  runningSandboxes: number;
};

const STARTERS: Suggestion[] = [
  { label: "Build a web app", prompt: "Build a responsive web app that ", kind: "start" },
  { label: "Build an API", prompt: "Build a small HTTP API with ", kind: "start" },
  { label: "Research a decision", prompt: "Research and compare ", kind: "start" },
];

/**
 * At most three, because a fourth is no longer a suggestion — it is a menu, and a menu is what
 * this is trying to replace.
 */
export const MAX_SUGGESTIONS = 3;

export function suggestNext(state: SuggestionState): Suggestion[] {
  // Never suggest anything over something a person is in the middle of typing.
  if (state.draft.trim().length > 0) return [];
  if (!state.hasWorkspace) return [];

  const suggestions: Suggestion[] = [];

  // Blocked first: a deliverable that failed its own contract is the most useful thing to know,
  // and the fix is a sentence away.
  for (const task of state.tasks.filter((task) => task.status === "blocked")) {
    suggestions.push({
      label: `Finish “${trim(task.title)}”`,
      prompt: task.blockedReason
        ? `The last run stopped: ${task.blockedReason} Complete it in the same workspace.`
        : `Continue “${task.title}” and complete what is missing.`,
      kind: "unblock",
      taskId: task.id,
    });
  }

  // Then anything finished that nobody has looked at.
  for (const task of state.tasks.filter((task) => task.status === "completed")) {
    suggestions.push({ label: `Open “${trim(task.title)}”`, prompt: "", kind: "inspect", taskId: task.id });
  }

  // Work in flight needs no suggestion of its own — the fleet panel is already showing it — but
  // a person watching one sandbox usually wants to start the next thing rather than wait.
  if (suggestions.length === 0 && state.runningSandboxes > 0) {
    suggestions.push({ label: "Start another in parallel", prompt: "", kind: "continue" });
  }

  if (suggestions.length === 0) suggestions.push(...STARTERS);
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

function trim(title: string, limit = 28): string {
  return title.length <= limit ? title : `${title.slice(0, limit - 1).trimEnd()}…`;
}
