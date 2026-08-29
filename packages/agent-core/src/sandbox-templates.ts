import { ALLOWED_SANDBOX_PROGRAMS, type AllowedSandboxProgram } from "./sandbox-policy";

/**
 * Workspace presets: prebuilt sandbox images for the kinds of work this system actually runs.
 *
 * These exist because the default `base` image ships eight of the fourteen programs the sandbox
 * policy permits — no ripgrep, no bun, no pytest — and a planner offered a tool the image lacks
 * fails on `command not found` for a reason that has nothing to do with the objective. Rather than
 * narrowing what an agent may attempt, each preset installs the tools its kind of work needs and
 * declares exactly what it ships, so the planner is told the truth about its own workspace.
 *
 * `programs` is the manifest, not an aspiration: it is what the build installs, and it is verified
 * against the built image by `bun run verify:templates`. Anything listed here that the image does
 * not actually have would reintroduce precisely the failure these presets exist to remove.
 */
export type WorkspacePreset = {
  id: string;
  label: string;
  description: string;
  /** The E2B template alias this preset builds to, and that a sandbox is created from. */
  templateAlias: string;
  /** Programs the built image ships, intersected with the policy allowlist before use. */
  programs: readonly AllowedSandboxProgram[];
};

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [
  {
    id: "general",
    label: "General",
    description: "The stock image: Python, Node and git, with no extra tooling. Fastest to start.",
    templateAlias: "base",
    // Verified by probing a live `base` sandbox — not assumed from the policy allowlist.
    programs: ["npm", "git", "node", "python", "python3", "ls", "pwd", "find"],
  },
  {
    id: "python-data",
    label: "Python + data",
    description: "Python with pytest, uv and ripgrep for scripting, analysis and test-driven work.",
    templateAlias: "circuit-python-data",
    programs: ["git", "python", "python3", "pytest", "uv", "rg", "ls", "pwd", "find"],
  },
  {
    id: "node-web",
    label: "Node + web",
    description: "Node with npm, bun and ripgrep for JavaScript and TypeScript projects.",
    templateAlias: "circuit-node-web",
    programs: ["npm", "bun", "node", "git", "rg", "ls", "pwd", "find"],
  },
  {
    id: "next-app",
    label: "Deployable Next.js app",
    description: "A production Next.js starter with dependencies installed for verified mobile web-app builds.",
    templateAlias: "circuit-next-web",
    programs: ["npm", "bun", "node", "git", "rg", "ls", "pwd", "find"],
  },
];

export const DEFAULT_WORKSPACE_PRESET_ID = "general";

export function findWorkspacePreset(id: string | undefined): WorkspacePreset {
  return WORKSPACE_PRESETS.find((preset) => preset.id === id) ?? WORKSPACE_PRESETS[0];
}

/**
 * The programs a preset may actually offer a planner: what the image ships, narrowed to what the
 * policy permits. A preset can never widen the security boundary by declaring extra tools — an
 * image that shipped a shell would still not make one available.
 */
export function presetPrograms(preset: WorkspacePreset): AllowedSandboxProgram[] {
  const permitted = new Set<string>(ALLOWED_SANDBOX_PROGRAMS);
  return preset.programs.filter((program) => permitted.has(program));
}

/**
 * Selects the deployable app image from intent, while leaving ordinary coding work lightweight.
 *
 * Two vocabularies, because one was not enough. `namesAnApp` is the explicit list — if someone says
 * "app" or "dashboard" they get the app image whatever else the sentence contains. `namesAWebSurface`
 * exists because people mostly do not say "app": they ask for a "page" or a "site", and those asks
 * were falling through to the plain image, which produced a bare index.html with nothing serving
 * port 3000, so the live preview answered 502. That is a silent downgrade of exactly the request
 * the app image is for.
 *
 * The surface words alone would over-match, though — "convert a Markdown file to an HTML page" is a
 * CLI, not a website — so a stated non-web artifact vetoes them. An explicit app word still wins,
 * which keeps "dashboard app with an API" on the app image.
 */
export function inferWorkspacePresetId(objective: string): string | undefined {
  const normalized = objective.toLowerCase();
  const asksToCreate = /\b(build|create|make|develop|design|scaffold|launch)\b/.test(normalized);
  const namesAnApp = /\b(app|application|website|dashboard|portal|platform|web ?app|saas)\b/.test(normalized);
  const namesAWebSurface = /\b(page|site|landing|storefront|front-?end|ui|web interface)\b/.test(normalized);
  const namesANonWebArtifact = /\b(command-?line|cli|library|module|package|script|api|endpoint|microservice|daemon|parser|converter)\b/.test(normalized);
  return asksToCreate && (namesAnApp || (namesAWebSurface && !namesANonWebArtifact)) ? "next-app" : undefined;
}
