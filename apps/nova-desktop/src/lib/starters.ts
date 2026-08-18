/**
 * What to show someone who has opened a project and asked nothing yet.
 *
 * The transcript at that point held a single line — "Opened /path · provider/model" — above an
 * empty screen the height of the window, which tells a first-time reader nothing about what this
 * thing is for. These are the smallest useful answer: three things that are true of any project.
 *
 * They fill the composer rather than sending, so the first message is still the reader's to edit,
 * and they are deliberately read-only requests. Offering "refactor this" as the first thing a new
 * user clicks would propose an edit before they have understood that modes decide what Nova may do
 * without asking.
 */
export const STARTERS: readonly string[] = [
  "What does this project do, and how is it laid out?",
  "Run the tests and tell me what fails",
  "Find the riskiest thing in this codebase",
];

/**
 * The last segment of a path — which project this is, without printing the whole path.
 *
 * Handles both separators regardless of host, because a Windows path can reach a session opened
 * from a config file written elsewhere, and trailing separators are stripped so that `C:\work\api\`
 * is still `api` rather than empty.
 */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * Whether the starters belong on screen.
 *
 * Only with a project open, nothing said yet, and nothing running. The message count is compared
 * against one rather than zero because opening a session posts a system line announcing where it
 * landed — the starters replace an empty transcript, not a transcript with something in it.
 */
export function shouldShowStarters(options: { root: string | null; messageCount: number; busy: boolean }): boolean {
  return Boolean(options.root) && options.messageCount <= 1 && !options.busy;
}
