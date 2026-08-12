import type { PermissionDecision } from "./settings";

/**
 * The approval dialog's rules, separated from its markup.
 *
 * This is the security boundary of the whole app — the one place a human decides whether the agent
 * may run a command or write a file — and it was the least usable thing in it: mouse-only, no
 * Escape, no focus trap, and a one-line summary where the CLI shows the exact command. Someone
 * approving twenty calls an hour with the mouse will start clicking the primary button by position,
 * which is indistinguishable from not reviewing at all.
 *
 * Two rules follow from that, and both are encoded here rather than in the component:
 *
 * - **Nothing dangerous is reachable by pressing Enter.** There is no default-focused "Yes". Enter
 *   on an unfocused dialog does nothing, and Escape means deny — the safe direction.
 * - **The letters match the CLI.** `y`/`n`/`a`/`d` already mean allow/deny/always/deny-always at
 *   the terminal prompt, and a user who learns them in one place should not be wrong in the other.
 */

export type ApprovalKeyResult = { decision: PermissionDecision } | { dismiss: true } | undefined;

export function approvalKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ApprovalKeyResult {
  // A modifier means the user is driving the OS or the app, not answering the question.
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  switch (event.key.toLowerCase()) {
    case "y": return { decision: "allow" };
    case "n": return { decision: "deny" };
    case "a": return { decision: "allow_always" };
    case "d": return { decision: "deny_always" };
    // Escape resolves rather than merely closing: a dialog that vanishes while the agent still
    // waits on an answer is a hang with no visible cause. Denying is the reading that cannot
    // approve something by accident.
    case "escape": return { decision: "deny" };
    default: return undefined;
  }
}

export type ApprovalDetail = {
  /** The exact text being authorised — a command line, a path, a URL. */
  subject?: string;
  /** Prose around the subject, if the summary carried any. */
  note?: string;
  /** True when this looks like it runs something, rather than reading or writing a file. */
  executes: boolean;
};

const EXECUTING_TOOLS = /^(run_command|bash|shell|execute|run)/i;

/**
 * Pulls the reviewable part out of a tool summary.
 *
 * The dialog has to show *what* is being approved, not just that something is. Summaries arrive as
 * `run_command: rm -rf build` or a bare path, so the part after the first colon is the subject when
 * there is one and the whole string otherwise. Deliberately conservative: when the shape is not
 * recognised the whole summary is shown verbatim, because truncating the thing under review to make
 * it fit a layout is exactly the wrong trade in this dialog.
 */
export function approvalDetail(toolName: string, summary: string): ApprovalDetail {
  const executes = EXECUTING_TOOLS.test(toolName);
  const trimmed = summary.trim();
  if (!trimmed) return { executes };

  // Only a bare identifier counts as a label. Splitting on any early ": " cuts real commands in
  // half — `curl -s https://example.com/a: b` would have shown the user "b" as the thing they were
  // approving. A prefix containing a space is part of the command, not a name for it.
  const separator = trimmed.indexOf(": ");
  const prefix = separator > 0 ? trimmed.slice(0, separator) : "";
  if (prefix && /^[\w.-]{1,40}$/.test(prefix)) {
    const subject = trimmed.slice(separator + 2).trim();
    // A label that merely repeats the tool name says nothing — the dialog already shows the tool.
    // Dropping it keeps the reader's eye on the one line that differs between calls.
    return prefix.toLowerCase() === toolName.toLowerCase() ? { subject, executes } : { note: prefix, subject, executes };
  }
  return { subject: trimmed, executes };
}
