/**
 * Builds the workspace preset images on E2B. Run with `bun run build:templates`.
 *
 * Builds happen on E2B's infrastructure, not locally, so this needs an API key and nothing else.
 * It is a deliberate manual step: images change rarely, a build takes minutes, and doing it from a
 * deploy would rebuild the world every time the app ships.
 */
import { Template, waitForTimeout } from "e2b";
import { WORKSPACE_PRESETS } from "@circuit-nova/nova-core/sandbox-templates";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required to build templates");

// Every sandbox this system creates works inside /workspace/repo, so the image must already have
// it. Creating it per run would spend a command on something the image can simply ship.
const WORKSPACE = "/workspace/repo";
// E2B sandboxes run as this unprivileged user — confirmed by the build's own npm error, which
// wrote its log to /home/user/.npm. The workspace must end up owned by it, not by root.
const SANDBOX_USER = "user";

// The builder narrows its own type as it goes (a finished template is no longer a base image),
// so the map is typed by what build() accepts rather than by the entry point.
const definitions: Record<string, () => Parameters<typeof Template.build>[0]> = {
  "circuit-python-data": () =>
    Template()
      .fromPythonImage("3.12")
      .setUser("root")
      .aptInstall(["git", "ripgrep"])
      // /workspace sits at the filesystem root, which the unprivileged sandbox user cannot create,
      // and everything the agent does happens inside it — so it is made as root and handed over.
      .runCmd(`mkdir -p ${WORKSPACE} && chown -R ${SANDBOX_USER}:${SANDBOX_USER} /workspace`)
      .setUser(SANDBOX_USER)
      .pipInstall(["pytest", "uv"])
      .setWorkdir(WORKSPACE)
      // Idle by default: a coding sandbox runs commands on demand and has no service to host.
      .setStartCmd("true", waitForTimeout(1_000)),
  "circuit-node-web": () =>
    Template()
      .fromNodeImage("22")
      .setUser("root")
      .aptInstall(["git", "ripgrep"])
      // A global npm install writes to /usr/local, which the sandbox user cannot touch — the first
      // build failed with EACCES. Both this and the workspace need root, so they share one block.
      .runCmd("npm install -g bun")
      .runCmd(`mkdir -p ${WORKSPACE} && chown -R ${SANDBOX_USER}:${SANDBOX_USER} /workspace`)
      .setUser(SANDBOX_USER)
      .setWorkdir(WORKSPACE)
      .setStartCmd("true", waitForTimeout(1_000)),
  "circuit-next-web": () =>
    Template()
      .fromNodeImage("22")
      .setUser("root")
      .aptInstall(["git", "ripgrep"])
      .runCmd("npm install -g bun")
      // Dependencies are resolved once while the reviewed image is built, never by an agent at
      // task time. Every app run starts from the same lockfile-backed, production-buildable base.
      .runCmd("npx create-next-app@16.2.12 /opt/circuit-next --ts --app --use-npm --eslint --no-tailwind --no-src-dir --import-alias '@/*' --yes")
      // The generated default imports Google fonts at build time. User tasks run with network
      // access disabled, so the reviewed starter is rewritten to a self-contained layout that
      // builds offline and reproducibly. A deterministic rewrite beats editing the generated file.
      .runCmd("printf '%s\\n' \"import type { Metadata } from 'next';\" \"import './globals.css';\" \"\" \"export const metadata: Metadata = { title: 'App', description: 'Generated application' };\" \"\" \"export default function RootLayout({ children }: { children: React.ReactNode }) {\" \"  return (<html lang=\\\"en\\\"><body>{children}</body></html>);\" \"}\" > /opt/circuit-next/app/layout.tsx")
      // E2B's filesystem transfer can omit dependency trees when copying directory layers. A tar
      // payload is an ordinary image file, so extracting it at startup preserves node_modules and
      // still performs zero network installs during a user task.
      .runCmd("tar -czf /opt/circuit-next.tgz -C /opt/circuit-next .")
      .runCmd(`mkdir -p ${WORKSPACE} && chown -R ${SANDBOX_USER}:${SANDBOX_USER} /workspace /opt/circuit-next`)
      .setUser(SANDBOX_USER)
      .setWorkdir(WORKSPACE)
      .setStartCmd(`tar -xzf /opt/circuit-next.tgz -C ${WORKSPACE}`, waitForTimeout(3_000)),
};

const requested = new Set(process.argv.slice(2));
const targets = WORKSPACE_PRESETS.filter((preset) => definitions[preset.templateAlias] && (requested.size === 0 || requested.has(preset.id)));
if (requested.size > 0 && targets.length !== requested.size) {
  throw new Error(`Unknown or non-buildable preset: ${[...requested].filter((id) => !targets.some((preset) => preset.id === id)).join(", ")}`);
}
console.log(`Building ${targets.length} workspace presets…`);

for (const preset of targets) {
  console.log(`\n=== ${preset.id} -> ${preset.templateAlias} ===`);
  const started = Date.now();
  try {
    await Template.build(definitions[preset.templateAlias](), preset.templateAlias, {
      apiKey,
      cpuCount: 2,
      memoryMB: 1024,
      onBuildLogs: (line: string) => process.stdout.write(`  ${line}\n`),
    } as never);
    console.log(`  built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
