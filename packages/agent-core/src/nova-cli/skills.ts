import type { NovaWorkspace } from "./backends";
import type { ExternalTool, ToolProvider } from "./tool-providers";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "./tool-schema";

/**
 * A skill: a small, named, project-local capability declared as data, not code Nova had to ship.
 *
 * Discovered from `.nova/skills/<name>/skill.json` — one directory per skill, so a skill can later
 * carry sibling files (a script `command` shells out to) without inventing a second convention.
 *
 * Both halves go through `NovaWorkspace`: discovery via `listConfigFiles` (which deliberately
 * bypasses the ignored-directory list that hides `.nova` from the agent's own searches — see the
 * interface comment in backends.ts), and execution via `runCommand`. So a skill committed to a
 * repository is found and runs identically on a local, E2B or Docker session, and running one is
 * subject to the same containment and environment sanitization as `run_command`.
 */
export type SkillManifest = {
  name: string;
  description: string;
  /** May contain `{{argName}}` placeholders — see `substitutePlaceholders`. */
  command: string;
  inputSchema: ToolInputSchema;
  timeoutMs?: number;
};

export const SKILLS_DIRECTORY = ".nova/skills";
const DEFAULT_SKILL_TIMEOUT_MS = 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates one `skill.json`. Throws with the manifest's path in the message on any defect. */
export function parseSkillManifest(displayPath: string, raw: string): SkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${displayPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${displayPath}: must be a JSON object`);
  const { name, description, command, inputSchema, timeoutMs } = parsed;
  if (typeof name !== "string" || !name.trim()) throw new Error(`${displayPath}: "name" must be a non-empty string`);
  if (typeof description !== "string" || !description.trim()) throw new Error(`${displayPath}: "description" must be a non-empty string`);
  if (typeof command !== "string" || !command.trim()) throw new Error(`${displayPath}: "command" must be a non-empty string`);
  assertSupportedSchema(name, inputSchema);
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`${displayPath}: "timeoutMs" must be a positive integer`);
  }
  return { name, description, command, inputSchema, timeoutMs: timeoutMs as number | undefined };
}

/**
 * Every `<skill>/skill.json` one level under `skillsDirectory`, read through the workspace so a
 * skill committed to a repository behaves identically on a local, E2B or Docker session.
 *
 * A manifest that fails to parse is reported, not skipped silently — a skill a developer thought
 * they added and that never actually loaded is a confusing, hard-to-notice gap; an error naming the
 * exact bad file is not. A missing directory is simply zero skills.
 */
export async function discoverSkillManifestsIn(workspace: NovaWorkspace, skillsDirectory: string): Promise<SkillManifest[]> {
  const files = await workspace.listConfigFiles(skillsDirectory);
  // Exactly one level deep: `<skillsDirectory>/<name>/skill.json`. A skill's own sibling files are
  // its business, and a stray skill.json nested deeper is not a skill directory.
  const manifestPaths = files.filter((file) => {
    const rest = file.slice(skillsDirectory.length + 1).split("/");
    return rest.length === 2 && rest[1] === "skill.json";
  });
  const manifests: SkillManifest[] = [];
  for (const manifestPath of manifestPaths) {
    const file = await workspace.readFile(manifestPath).catch(() => null);
    if (!file) continue;
    manifests.push(parseSkillManifest(manifestPath, file.content));
  }
  return manifests;
}

/** Every `.nova/skills/<skill>/skill.json` in the workspace. */
export function discoverSkillManifests(workspace: NovaWorkspace): Promise<SkillManifest[]> {
  return discoverSkillManifestsIn(workspace, SKILLS_DIRECTORY);
}

/**
 * Fills `{{argName}}` placeholders in a skill's `command` with its validated, scalar arguments.
 *
 * Each value is single-quoted with embedded quotes escaped (the standard POSIX-safe technique:
 * `'` becomes `'\''`), rather than concatenated raw — a skill argument is model-controlled input,
 * and `{{query}}` becoming `foo; rm -rf /` in an unquoted command string is exactly the injection a
 * quoting scheme this simple and this well-established exists to close. Array-valued arguments
 * (the one array coercion `validateToolArguments` performs) are joined space-separated, each element
 * quoted the same way.
 */
export function substitutePlaceholders(command: string, args: Record<string, unknown>, platform: NodeJS.Platform = "linux"): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in args)) throw new Error(`Skill command references {{${name}}}, which was not provided`);
    const value = args[name];
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => shellQuote(String(item), platform)).join(" ");
  });
}

/**
 * Quotes one argument for the shell that will actually run it.
 *
 * The two shells disagree on the fundamentals, so one scheme cannot serve both: `cmd.exe` gives no
 * meaning to a single quote at all, which means POSIX `'...'` quoting does not merely fail to
 * protect an argument there — it passes the quote marks through as literal characters and leaves
 * every metacharacter inside them live. Defaults to POSIX because that is what every sandbox runs;
 * only a local Windows workspace asks for the other.
 */
function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return `'${value.replace(/'/g, `'\\''`)}'`;
  // cmd.exe: double quotes group, `""` escapes a literal quote inside them, and `%` must be
  // defused or the shell expands a variable the caller never wrote. `^` escaping is not used here
  // because inside double quotes cmd does not treat `& | < > ( )` as special in the first place.
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

/** Exposes every discovered skill as a `ToolProvider`, executed through the workspace's own `runCommand`. */
export class SkillToolProvider implements ToolProvider {
  readonly kind = "skill" as const;

  /** `skillsDirectory` is workspace-root-relative — `.nova/skills`, or a specific plugin's own. */
  constructor(readonly id: string, private readonly skillsDirectory: string, private readonly workspace: NovaWorkspace) {}

  async listTools(): Promise<ExternalTool[]> {
    const manifests = await discoverSkillManifestsIn(this.workspace, this.skillsDirectory);
    return manifests.map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      inputSchema: manifest.inputSchema,
      invoke: async (argumentsValue) => {
        const validated = validateToolArguments(manifest.name, manifest.inputSchema, argumentsValue);
        const command = substitutePlaceholders(manifest.command, validated, this.workspace.commandPlatform);
        const result = await this.workspace.runCommand(command, manifest.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS);
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        return { content: `exit ${result.exitCode}\n${body}`, isError: result.exitCode !== 0 };
      },
    }));
  }
}
