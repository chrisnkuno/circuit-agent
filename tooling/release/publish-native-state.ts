import { promises as fs } from "node:fs";
import path from "node:path";

const SUFFIXES = [
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const packagesDirectory = path.resolve(argument("--packages-dir") ?? "release-packages");
const version = argument("--version");
const publish = process.argv.includes("--publish");
const provenance = process.argv.includes("--provenance");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be a valid release version");
}

declare const Bun: { spawn(command: string[], options: Record<string, unknown>): { exited: Promise<number> } };

for (const suffix of SUFFIXES) {
  const directory = path.join(packagesDirectory, suffix);
  const manifestFile = path.join(directory, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as { name?: string; version?: string };
  const expectedName = `@circuit-nova/state-${suffix}`;
  if (manifest.name !== expectedName || manifest.version !== version) {
    throw new Error(`${manifestFile} must describe ${expectedName}@${version}`);
  }
  const binary = path.join(directory, "bin", suffix.startsWith("win32") ? "nova-state.exe" : "nova-state");
  const stat = await fs.stat(binary);
  if (!stat.isFile() || stat.size < 100_000) throw new Error(`${binary} is not a plausible release binary`);

  const command = publish
    ? ["npm", "publish", directory, "--access", "public", ...(provenance ? ["--provenance"] : [])]
    : ["npm", "pack", directory, "--dry-run"];
  const child = Bun.spawn(command, {
    cwd: packagesDirectory,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? path.join(packagesDirectory, ".npm-cache") },
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.slice(0, 2).join(" ")} failed for ${expectedName} with exit code ${code}`);
}

console.log(`${publish ? "published" : "verified"} ${SUFFIXES.length} native state packages at ${version}`);
