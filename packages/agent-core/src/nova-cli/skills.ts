import { promises as fs } from "node:fs";
import path from "node:path";
import type { NovaWorkspace } from "./backends";
import type { ExternalTool, ToolProvider } from "./tool-providers";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "./tool-schema";

/**
 * A skill: a small, named, project-local capability declared as data, not code Nova had to ship.
 *
 * Discovered from `.nova/skills/<name>/skill.json` — one directory per skill, so a skill can later
 * carry sibling files (a script `command` shells out to) without inventing a second convention.
 *
 * Discovery reads through `node:fs` directly against the workspace root, local sessions only — the
 * same deliberate, documented scope `NestedInstructionTracker` (nested-instructions.ts) already
 * uses, for the same two reasons: `.nova` is in every backend's `ignoredDirectories`, so the
 * `NovaWorkspace.list`/`glob` a remote-safe discovery would need never even sees it, and for a
 * remote E2B/Docker session the workspace root passed to `NovaAgent` is only where session and
 * checkpoint bookkeeping live locally, not a mirror of the sandbox's actual files. Execution is not
 * similarly restricted: a discovered skill's `command` runs through `NovaWorkspace.runCommand`, so
 * once discovered it runs wherever the session runs — the containment/sanitization work in
 * command.ts applies to it exactly as it does to `run_command`.
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
 * Every `<skill>/skill.json` directly under `skillsDirectory` (an absolute path). A manifest that fails to
 * parse is reported, not skipped silently — a skill a developer thought they added and that never
 * actually loaded is a confusing, hard-to-notice gap; a startup error naming the exact bad file is
 * not. A missing directory is simply zero skills, not an error. `displayPrefix` is only cosmetic —
 * what error messages call the directory, so a plugin's skills report their plugin-relative path
 * rather than an absolute one.
 */
export async function discoverSkillManifestsIn(skillsDirectory: string, displayPrefix: string): Promise<SkillManifest[]> {
  const skillDirectories = await fs.readdir(skillsDirectory, { withFileTypes: true }).catch(() => []);
  const manifests: SkillManifest[] = [];
  for (const entry of skillDirectories) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(skillsDirectory, entry.name, "skill.json");
    const raw = await fs.readFile(manifestPath, "utf8").catch(() => null);
    if (raw === null) continue;
    manifests.push(parseSkillManifest(`${displayPrefix}/${entry.name}/skill.json`, raw));
  }
  return manifests;
}

/** Every `.nova/skills/<skill>/skill.json` under the workspace root. */
export function discoverSkillManifests(root: string): Promise<SkillManifest[]> {
  return discoverSkillManifestsIn(path.join(root, SKILLS_DIRECTORY), SKILLS_DIRECTORY);
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
export function substitutePlaceholders(command: string, args: Record<string, unknown>): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in args)) throw new Error(`Skill command references {{${name}}}, which was not provided`);
    const value = args[name];
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => shellQuote(String(item))).join(" ");
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Exposes every discovered skill as a `ToolProvider`, executed through the workspace's own `runCommand`. */
export class SkillToolProvider implements ToolProvider {
  readonly kind = "skill" as const;

  /** `skillsDirectory` is absolute — the workspace root plus whichever skills directory this provider covers (top-level `.nova/skills`, or a specific plugin's). */
  constructor(readonly id: string, private readonly skillsDirectory: string, private readonly workspace: NovaWorkspace) {}

  async listTools(): Promise<ExternalTool[]> {
    const manifests = await discoverSkillManifestsIn(this.skillsDirectory, this.id);
    return manifests.map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      inputSchema: manifest.inputSchema,
      invoke: async (argumentsValue) => {
        const validated = validateToolArguments(manifest.name, manifest.inputSchema, argumentsValue);
        const command = substitutePlaceholders(manifest.command, validated);
        const result = await this.workspace.runCommand(command, manifest.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS);
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        return { content: `exit ${result.exitCode}\n${body}`, isError: result.exitCode !== 0 };
      },
    }));
  }
}
