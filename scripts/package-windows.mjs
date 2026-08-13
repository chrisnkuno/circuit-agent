#!/usr/bin/env node
/**
 * Cross-platform packaging helper for Nova Desktop.
 *
 * Usage (from apps/nova-desktop):
 *   node scripts/package-windows.mjs
 *
 * On a Windows machine with Rust MSVC toolchain installed, this builds the
 * MSI/NSIS installers. On Linux it prepares the sidecar helpers and prints
 * the Windows build command to run under CI or a Windows host.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "sidecar:bundle"]);

if (platform() === "win32") {
  run("npm", ["run", "tauri", "--", "build", "--target", "x86_64-pc-windows-msvc"]);
  console.log("Windows installers written under src-tauri/target/x86_64-pc-windows-msvc/release/bundle/");
} else {
  console.log("Sidecar helpers prepared.");
  console.log("To produce Windows installers, run on Windows (or a Windows CI runner):");
  console.log("  rustup target add x86_64-pc-windows-msvc");
  console.log("  npm run tauri -- build --target x86_64-pc-windows-msvc");
  console.log("The self-contained sidecar exe is produced by sidecar:bundle (bun build --compile).");
}
