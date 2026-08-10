/**
 * Bundle the sidecar into one CJS file (with nova-core inlined), then pkg a Windows .exe.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");
const require = createRequire(import.meta.url);
mkdirSync(outDir, { recursive: true });

const tsc = spawnSync("npx", ["tsc", "-p", "sidecar/tsconfig.json"], { cwd: root, stdio: "inherit", shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const entry = join(root, "sidecar", "dist", "index.js");
const bundle = join(root, "sidecar", "dist", "sidecar.cjs");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: bundle,
  // e2b is optional at runtime for non-sandbox sessions
  external: ["e2b", "@anthropic-ai/sdk"],
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});

writeFileSync(
  join(root, "sidecar", "dist", "pkg-package.json"),
  JSON.stringify({ name: "nova-sidecar", bin: "sidecar.cjs", pkg: { assets: [], scripts: ["sidecar.cjs"] } }, null, 2),
);

const pkgOut = join(outDir, "nova-sidecar-win.exe");
const pkgBin = require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
const pkg = spawnSync(
  process.execPath,
  [pkgBin, bundle, "--targets", "node22-win-x64", "--output", pkgOut, "--compress", "GZip"],
  { cwd: root, stdio: "inherit" },
);
if (pkg.status !== 0) process.exit(pkg.status ?? 1);

const tauriName = join(outDir, "nova-sidecar-x86_64-pc-windows-msvc.exe");
if (existsSync(tauriName)) unlinkSync(tauriName);
renameSync(pkgOut, tauriName);
copyFileSync(tauriName, join(outDir, "nova-sidecar.exe"));
console.log("Windows sidecar ready:", tauriName);
console.log("Size:", Math.round(readFileSync(tauriName).byteLength / 1024 / 1024), "MB");
