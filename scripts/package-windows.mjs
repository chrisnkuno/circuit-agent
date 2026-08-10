#!/usr/bin/env node
/**
 * Build Windows portable Nova Desktop.
 * On Linux: cross-compiles with cargo-xwin + llvm-rc.
 * On Windows: native tauri build.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, cwd: root, ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "sidecar:windows"]);
run("npm", ["run", "build"]);

if (platform() === "win32") {
  run("npm", ["run", "tauri", "--", "build", "--target", "x86_64-pc-windows-msvc"]);
} else {
  const path = `/usr/lib/llvm-21/bin:/usr/lib/llvm-20/bin:${process.env.PATH || ""}`;
  run("npx", ["tauri", "build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc", "--no-bundle"], {
    env: { ...process.env, PATH: path },
  });
}

const out = join(root, "release", "windows");
mkdirSync(join(out, "binaries"), { recursive: true });

const candidates = [
  join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "nova-desktop.exe"),
  "/tmp/cursor-sandbox-cache/ebaa554b063b0437c8de7df7123692a9/cargo-target/x86_64-pc-windows-msvc/release/nova-desktop.exe",
];
const exe = candidates.find((p) => existsSync(p));
const sidecar = join(root, "src-tauri", "binaries", "nova-sidecar-x86_64-pc-windows-msvc.exe");
if (!exe || !existsSync(sidecar)) {
  console.error("Missing Nova.exe or sidecar after build");
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
