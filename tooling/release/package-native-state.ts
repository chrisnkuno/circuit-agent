import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Target = { packageSuffix: string; os: "linux" | "darwin" | "win32"; cpu: "x64" | "arm64"; libc?: "glibc" | "musl"; executable: string };

const TARGETS: Readonly<Record<string, Target>> = {
  "x86_64-unknown-linux-gnu": { packageSuffix: "linux-x64-gnu", os: "linux", cpu: "x64", libc: "glibc", executable: "nova-state" },
  "aarch64-unknown-linux-gnu": { packageSuffix: "linux-arm64-gnu", os: "linux", cpu: "arm64", libc: "glibc", executable: "nova-state" },
  "x86_64-unknown-linux-musl": { packageSuffix: "linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", executable: "nova-state" },
  "aarch64-unknown-linux-musl": { packageSuffix: "linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", executable: "nova-state" },
  "x86_64-apple-darwin": { packageSuffix: "darwin-x64", os: "darwin", cpu: "x64", executable: "nova-state" },
  "aarch64-apple-darwin": { packageSuffix: "darwin-arm64", os: "darwin", cpu: "arm64", executable: "nova-state" },
  "x86_64-pc-windows-msvc": { packageSuffix: "win32-x64", os: "win32", cpu: "x64", executable: "nova-state.exe" },
  "aarch64-pc-windows-msvc": { packageSuffix: "win32-arm64", os: "win32", cpu: "arm64", executable: "nova-state.exe" },
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const targetName = argument("--target");
const version = argument("--version");
if (!targetName || !TARGETS[targetName]) throw new Error(`--target must be one of: ${Object.keys(TARGETS).join(", ")}`);
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("--version must be a valid release version");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "packages", "nova-state");
const outputRoot = path.resolve(argument("--out-dir") ?? path.join(root, "artifacts", "nova-state-npm"));
const target = TARGETS[targetName];
const output = path.join(outputRoot, target.packageSuffix);
const suppliedBinary = argument("--binary");

declare const Bun: { spawn(command: string[], options: Record<string, unknown>): { exited: Promise<number> } };
if (!suppliedBinary) {
  const build = Bun.spawn(["cargo", "build", "--locked", "--release", "--manifest-path", path.join(crate, "Cargo.toml"), "--target", targetName, "--bin", "nova-state"], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  const code = await build.exited;
  if (code !== 0) throw new Error(`cargo build failed with exit code ${code}`);
}

const binary = path.resolve(suppliedBinary ?? path.join(crate, "target", targetName, "release", target.executable));
await fs.access(binary);
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.join(output, "bin"), { recursive: true });
await fs.copyFile(binary, path.join(output, "bin", target.executable));
if (target.os !== "win32") await fs.chmod(path.join(output, "bin", target.executable), 0o755);

const manifest = {
  name: `@circuit-nova/state-${target.packageSuffix}`,
  version,
  description: `Native nova-state history and memory index for ${target.packageSuffix}`,
  license: "MIT",
  os: [target.os],
  cpu: [target.cpu],
  ...(target.libc ? { libc: [target.libc] } : {}),
  files: ["bin", "README.md", "LICENSE"],
  engines: { node: ">=22.5" },
  publishConfig: { access: "public" },
};
await fs.writeFile(path.join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.copyFile(path.join(crate, "README.md"), path.join(output, "README.md"));
await fs.copyFile(path.join(root, "packages", "agent-core", "LICENSE"), path.join(output, "LICENSE"));
console.log(`${manifest.name}@${version} staged at ${output}`);
