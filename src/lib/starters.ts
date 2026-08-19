/**
 * What to call the project that is open.
 *
 * The starter prompts that used to live here moved into the shared suggestion engine
 * (`nova-core/nova-cli/suggestions`), because the terminal needs the same three sentences into its
 * own empty session and two hand-maintained copies of "what should I ask first" is exactly the
 * drift that engine exists to end. What stays is the part that is genuinely about this window: a
 * path, shortened to the name a person would use for it.
 */

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
