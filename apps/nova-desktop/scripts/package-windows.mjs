#!/usr/bin/env node
/**
 * Builds the Windows installers.
 *
 * The sidecar is compiled first, for the Windows triple specifically rather than for this machine:
 * `bun build --compile` cross-compiles, so the executable Tauri bundles is a real Windows PE
 * whether this runs on a Windows host or a Linux CI runner.
 *
 * Tauri itself still cannot cross-compile — the MSI and NSIS targets need the MSVC toolchain — so
 * the installer step only runs on Windows. On any other platform this prepares and verifies the
 * artifact, then prints the one command left to run, which is the honest thing to do rather than
 * failing halfway through with a linker error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";
const SIDECAR = join(ROOT, "src-tauri", "binaries", `nova-sidecar-${WINDOWS_TRIPLE}.exe`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "sidecar:binary", "--", WINDOWS_TRIPLE]);

// Checked rather than assumed: a missing or stub sidecar is exactly the failure this script exists
// to prevent, and it is far cheaper to catch here than in an installer on someone else's machine.
if (!existsSync(SIDECAR)) {
  console.error(`Expected a Windows sidecar at ${SIDECAR} and it is not there.`);
  process.exit(1);
}
const megabytes = statSync(SIDECAR).size / 1024 / 1024;
if (megabytes < 20) {
  console.error(`${SIDECAR} is only ${megabytes.toFixed(1)} MB — too small to embed a runtime, so it is probably a wrapper script rather than a real executable.`);
  process.exit(1);
}
console.log(`Windows sidecar ready: ${SIDECAR} (${megabytes.toFixed(0)} MB, self-contained — the target machine needs no Node).`);

if (platform() === "win32") {
  run("npm", ["run", "tauri", "--", "build", "--target", WINDOWS_TRIPLE]);
  console.log(`Installers written under src-tauri/target/${WINDOWS_TRIPLE}/release/bundle/`);
} else {
  console.log("");
  console.log("Tauri's MSI and NSIS targets need the MSVC toolchain, so run the last step on Windows:");
  console.log(`  npm run tauri -- build --target ${WINDOWS_TRIPLE}`);
}
