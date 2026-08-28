/**
 * When a quoted sandbox may start without asking.
 *
 * The price gate exists so nobody is billed for work they did not ask for, and it is worth
 * keeping — but asking twice for something a person has already said yes to is not safety, it is
 * friction. A workspace sets a ceiling it is willing to spend without being interrupted; anything
 * at or under it runs the moment it is quoted, and anything over it still stops and asks.
 *
 * That is the whole rule, and it is deliberately not "auto-approve everything": the cases that
 * still interrupt are the ones a person would actually want to see.
 */

/** The ceiling a workspace runs under when it has not chosen one. */
export const DEFAULT_AUTO_APPROVE_RWF = 5_000;

/** A cap of zero means every sandbox asks — the old behaviour, still available. */
export const MANUAL_ONLY_RWF = 0;

export type AutomationDecision =
  | { automatic: true; reason: string }
  | { automatic: false; reason: string };

export function automationCap(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured) || configured < 0) return DEFAULT_AUTO_APPROVE_RWF;
  return Math.floor(configured);
}

/**
 * Only a sandbox start is ever automatic. A budget overage means the work already cost more than
 * it was quoted, and an external action changes something outside this system — both are exactly
 * the moments a person wants to be asked, whatever the ceiling says.
 */
export function decideAutomation(input: { kind: string; quotedRwf: number; configuredCapRwf: number | undefined }): AutomationDecision {
  const cap = automationCap(input.configuredCapRwf);
  if (input.kind !== "task_start") return { automatic: false, reason: `${input.kind.replaceAll("_", " ")} always needs a person` };
  if (cap === MANUAL_ONLY_RWF) return { automatic: false, reason: "this workspace approves every sandbox by hand" };
  if (!Number.isFinite(input.quotedRwf) || input.quotedRwf < 0) return { automatic: false, reason: "the quote could not be read" };
  if (input.quotedRwf > cap) return { automatic: false, reason: `quoted above the ${cap.toLocaleString()} RWF automation ceiling` };
  return { automatic: true, reason: `within the ${cap.toLocaleString()} RWF automation ceiling` };
}
