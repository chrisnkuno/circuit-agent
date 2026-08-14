#!/usr/bin/env node
/**
 * Builds the portable Windows app.
 *
 * The sidecar is compiled first, for the Windows triple specifically rather than for this machine:
 * `bun build --compile` cross-compiles, so the executable Tauri bundles is a real Windows PE
 * whether this runs on a Windows host or a Linux CI runner.
 *
 * The app itself is then built natively on Windows, and through cargo-xwin + llvm-rc elsewhere,
 * which is what lets the whole portable folder be produced from a Linux runner.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";
const SIDECAR = join(root, "src-tauri", "binaries", `nova-sidecar-${WINDOWS_TRIPLE}.exe`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true, ...options });
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

run("npm", ["run", "build"]);

if (platform() === "win32") {
  run("npm", ["run", "tauri", "--", "build", "--target", WINDOWS_TRIPLE]);
} else {
  // Tauri cannot use the MSVC toolchain here, but cargo-xwin can link a Windows binary from Linux.
  // `--no-bundle` because the MSI and NSIS targets still need Windows; the portable folder below
  // is what this path produces, and it is a complete, runnable app.
  const path = `/usr/lib/llvm-21/bin:/usr/lib/llvm-20/bin:${process.env.PATH || ""}`;
  run("npx", ["tauri", "build", "--runner", "cargo-xwin", "--target", WINDOWS_TRIPLE, "--no-bundle"], {
    env: { ...process.env, PATH: path },
  });
}

const out = join(root, "release", "windows");
mkdirSync(join(out, "binaries"), { recursive: true });

const exe = join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "nova-desktop.exe");
const sidecar = join(root, "src-tauri", "binaries", "nova-sidecar-x86_64-pc-windows-msvc.exe");
if (!existsSync(exe) || !existsSync(sidecar)) {
  console.error(`Missing ${exe} or ${sidecar} after build. Run this script after a successful build.`);
  process.exit(1);
}
copyFileSync(exe, join(out, "Nova.exe"));
copyFileSync(sidecar, join(out, "nova-sidecar.exe"));
copyFileSync(sidecar, join(out, "binaries", "nova-sidecar.exe"));
writeFileSync(
  join(out, "README.txt"),
  "Nova Desktop (portable)\n\nKeep this folder intact and run Nova.exe\nNeeds WebView2 on Windows.\nDefault API: https://api.circuitnotion.com/v1\n",
);
console.log("Windows portable build ready:", out);
