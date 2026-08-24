import { formatRwf } from "./task-cost";

export type RunLifecycleEvent = "started" | "completed" | "failed" | "cancelled";

export type RunNotification = {
  event: RunLifecycleEvent;
  taskTitle: string;
  objective: string;
  spentRwf: number;
  maxRwf: number;
  /** The worker's own summary of the terminal step, when there is one. */
  detail?: string;
  /** Absolute URL of the terminal, so a notification is one click from the live run. */
  workspaceUrl?: string;
};

export type ComposedMessage = { subject: string; text: string };

const HEADLINE: Record<RunLifecycleEvent, string> = {
  started: "Started",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * Composes one lifecycle notification.
 *
 * Every message states what was spent against what was approved, including on failure and
 * cancellation. A notification that reports an outcome without its cost invites the reader to
 * assume the cost was zero, and for a stopped or failed run that is usually wrong.
 */
export function composeRunNotification(notification: RunNotification): ComposedMessage {
  const title = truncate(notification.taskTitle, 80);
  const subject = `${HEADLINE[notification.event]}: ${title}`;
  const spend = `${formatRwf(notification.spentRwf)} of ${formatRwf(notification.maxRwf)} approved`;

  const lines = [
    notification.event === "started"
      ? `Your coding task has started.`
      : `Your coding task ${notification.event === "completed" ? "completed" : notification.event === "failed" ? "failed" : "was stopped"}.`,
    "",
    `Objective: ${truncate(notification.objective, 300)}`,
    notification.event === "started" ? `Approved cap: ${formatRwf(notification.maxRwf)}` : `Spent: ${spend}`,
  ];

  if (notification.detail) lines.push("", truncate(notification.detail, 500));
  if (notification.workspaceUrl) lines.push("", `Follow it live: ${notification.workspaceUrl}`);

  return { subject: truncate(subject, 200), text: lines.join("\n") };
}

/**
 * Chooses who receives a workspace notification.
 *
 * Only addresses that were actually recorded are returned, de-duplicated and lower-cased —
 * members who joined before contact details were stored simply are not emailed, which is
 * better than guessing an address for them.
 */
export function selectNotificationRecipients(members: Array<{ notificationEmail?: string; status: string }>): string[] {
  const addresses = members
    .filter((member) => member.status === "active")
    .map((member) => member.notificationEmail?.trim().toLowerCase())
    .filter((address): address is string => Boolean(address));
  return [...new Set(addresses)];
}
