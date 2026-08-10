import { mkdirSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

// Dev/Linux helper script that launches the compiled sidecar with node.
const helper = join(outDir, "nova-sidecar");
const script = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
exec node "$ROOT/sidecar/dist/index.js" "$@"
`;
import { writeFileSync } from "node:fs";
writeFileSync(helper, script);
chmodSync(helper, 0o755);

// Windows helper
writeFileSync(
  join(outDir, "nova-sidecar.cmd"),
  `@echo off\r\nnode "%~dp0..\\..\\sidecar\\dist\\index.js" %*\r\n`,
);

// Target-triple names expected by Tauri externalBin when present.
const triple = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
if (triple.status === 0) {
  const host = triple.stdout.trim();
  copyFileSync(helper, join(outDir, `nova-sidecar-${host}`));
  chmodSync(join(outDir, `nova-sidecar-${host}`), 0o755);
  // Windows release builds expect .exe — document that CI should replace with pkg binary.
  writeFileSync(
    join(outDir, `nova-sidecar-x86_64-pc-windows-msvc.cmd`),
    `@echo off\r\nnode "%~dp0..\\..\\sidecar\\dist\\index.js" %*\r\n`,
  );
}

console.log("Sidecar helpers written to", outDir);
console.log("For Windows release, replace helpers with a pkg/SEA binary named nova-sidecar-x86_64-pc-windows-msvc.exe");
