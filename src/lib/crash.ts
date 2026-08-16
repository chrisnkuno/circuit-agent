/**
 * What a crash looks like to the person it happened to, and to whoever they report it to.
 *
 * Kept out of the component for the same reason every other decision in `lib/` is: a React error
 * boundary can only be exercised by rendering one, and this project has no DOM test harness. The
 * boundary is therefore reduced to "catch, then draw what this file says", and everything that can
 * actually be wrong — a thrown non-Error, a missing stack, an unreadable message — is decided here
 * where it can be tested by comparing values.
 */

export type CrashReport = {
  /** One line, for the heading. Never empty, whatever was thrown. */
  summary: string;
  /** The stack if there was one, else the best description available. */
  detail: string;
};

/**
 * Anything can be thrown in JavaScript, and a crash reporter that assumes `Error` crashes itself
 * while reporting the crash — which is how a white screen becomes a white screen with no clue on it.
 */
export function describeCrash(error: unknown): CrashReport {
  if (error instanceof Error) {
    const summary = error.message.trim() || error.name || "Something went wrong";
    return { summary: firstLine(summary), detail: error.stack?.trim() || summary };
  }
  if (typeof error === "string" && error.trim() !== "") {
    return { summary: firstLine(error.trim()), detail: error.trim() };
  }
  // An object with no message, `null`, `undefined`, a number. Show its shape rather than "[object
  // Object]", which tells the person reporting it nothing at all.
  const rendered = safeStringify(error);
  return { summary: "Something went wrong", detail: rendered };
}

function firstLine(text: string): string {
  const [line] = text.split("\n");
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function safeStringify(value: unknown): string {
  try {
    // A circular structure is exactly the kind of thing that gets thrown by accident, so the
    // stringify that reports it must not be the second thing to fail.
    return JSON.stringify(value, undefined, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The text the "Copy details" button puts on the clipboard.
 *
 * A version and a platform, because the first question asked about any desktop crash report is
 * which build it came from, and the person pasting it should not have to go and find out.
 */
export function crashReportText(report: CrashReport, context: { version: string; platform: string }): string {
  return [
    `Nova ${context.version} (${context.platform})`,
    "",
    report.summary,
    "",
    report.detail,
  ].join("\n");
}
