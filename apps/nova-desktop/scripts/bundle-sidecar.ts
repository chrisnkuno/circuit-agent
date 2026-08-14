import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

// Compile TypeScript sidecar to dist, then produce a runnable JS entry that Node can execute.
const build = spawnSync("npx", ["tsc", "-p", "sidecar/tsconfig.json"], { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const entry = join(root, "sidecar", "dist", "index.js");
if (!existsSync(entry)) {
  console.error("sidecar dist missing after tsc");
  process.exit(1);
}

// Dev/Linux helper scripts that launch the compiled sidecar with node (used when
// developing on a machine that already has Node installed).
const helper = join(outDir, "nova-sidecar");
const script = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
exec node "$ROOT/sidecar/dist/index.js" "$@"
`;
writeFileSync(helper, script);
chmodSync(helper, 0o755);

writeFileSync(
  join(outDir, "nova-sidecar.cmd"),
  `@echo off\r\nnode "%~dp0..\\..\\sidecar\\dist\\index.js" %*\r\n`,
);

// Resolve the `bun` binary. Directly executable on mac/linux and on CI runners
// (oven-sh/setup-bun installs bun.exe on PATH); on Windows npm installs bun as a
// .ps1 wrapper so we fall back to the bundled exe from the global npm package.
function findBunExecutable(): string {
  const direct = spawnSync("bun", ["--version"], { encoding: "utf8", shell: false });
  if (direct.status === 0) return "bun";

  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  if (npmRoot.status === 0) {
    const global = npmRoot.stdout.trim();
    const exe = join(global, "bun", "bin", "bun.exe");
    if (existsSync(exe)) return exe;
  }
  return "bun";
}

// Self-contained Windows binary. `bun build --compile` bundles the Bun runtime
// with the sidecar + nova-core so end users do NOT need Node installed.
// `--minify --smol` keeps the resulting executable as small as possible.
// Run this on Windows (or a windows-latest CI runner) to produce the exe that
// Tauri's `externalBin` picks up for release builds.
const winTriple = "x86_64-pc-windows-msvc";
const winExe = join(outDir, `nova-sidecar-${winTriple}.exe`);
if (process.platform === "win32") {
  const bunExe = findBunExecutable();
  const compiled = spawnSync(
    bunExe,
    ["build", entry, "--compile", "--outfile", winExe, "--minify", "--smol"],
    { cwd: root, stdio: "inherit", shell: false },
  );
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
  console.log(`Self-contained sidecar written to ${winExe}`);
} else {
  console.log("Not on Windows: skipping the self-contained exe. Run this script on a Windows host (or CI windows-latest) to produce nova-sidecar-x86_64-pc-windows-msvc.exe");
}

// Copy the dev helper under its host triple so Tauri's `externalBin` resolves it
// on Linux/macOS dev machines (mirrors the sidecar:windows pkg flow).
const triple = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
if (triple.status === 0) {
  const host = triple.stdout.trim();
  copyFileSync(helper, join(outDir, `nova-sidecar-${host}`));
  chmodSync(join(outDir, `nova-sidecar-${host}`), 0o755);
}

console.log("Sidecar helpers written to", outDir);
