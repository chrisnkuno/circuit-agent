import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const build = spawnSync("npx", ["tsc", "-p", "sidecar/tsconfig.json"], { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const entry = join(root, "sidecar", "dist", "index.js");
if (!existsSync(entry)) {
  console.error("sidecar dist missing after tsc");
  process.exit(1);
}

const helper = join(outDir, "nova-sidecar");
writeFileSync(
  helper,
  `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
exec node "$ROOT/sidecar/dist/index.js" "$@"
`,
);
chmodSync(helper, 0o755);
writeFileSync(join(outDir, "nova-sidecar.cmd"), `@echo off\r\nnode "%~dp0..\\..\\sidecar\\dist\\index.js" %*\r\n`);

const triple = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
if (triple.status === 0) {
  const host = triple.stdout.trim();
  copyFileSync(helper, join(outDir, `nova-sidecar-${host}`));
  chmodSync(join(outDir, `nova-sidecar-${host}`), 0o755);
}

console.log("Sidecar helpers written to", outDir);
