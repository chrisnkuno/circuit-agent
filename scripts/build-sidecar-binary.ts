import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Compiles the sidecar into a real, self-contained executable.
 *
 * The app used to ship a shell script and a `.cmd` that shelled out to `node "…/sidecar/dist/
 * index.js"`. Three things were wrong with that, and only the first was visible:
 *
 * 1. Tauri's `externalBin` looks for `nova-sidecar-<target-triple>`, plus `.exe` on Windows. The
 *    script wrote a `.cmd`, so a Windows build could not find its own sidecar — the same failure
 *    the Linux build hit until `beforeDevCommand` was fixed.
 * 2. The path it pointed at is relative to the *development tree*. Inside an installed app that
 *    directory does not exist, so even a found helper would have failed at launch.
 * 3. It required Node on the end user's machine. A desktop installer that quietly depends on a
 *    developer toolchain is not something you can hand to someone.
 *
 * `bun build --compile` embeds the runtime and the bundle in one file, and — the reason it is used
 * here rather than Node's SEA — it cross-compiles. A Windows executable can be produced from Linux
 * or macOS, so releasing does not require a Windows host, and CI can prove the artifact exists on
 * every platform from any one of them.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src-tauri", "binaries");
const ENTRY = join(ROOT, "sidecar", "src", "index.ts");

/**
 * Rust target triples — what Tauri names the file after — mapped to Bun's own target names.
 *
 * Kept explicit rather than derived: the two projects use different spellings for the same
 * machine, and a silent mismatch produces a binary Tauri will not look for.
 */
const TARGETS: Record<string, { bun: string; exe: boolean }> = {
  "x86_64-pc-windows-msvc": { bun: "bun-windows-x64", exe: true },
  "x86_64-unknown-linux-gnu": { bun: "bun-linux-x64", exe: false },
  "aarch64-unknown-linux-gnu": { bun: "bun-linux-arm64", exe: false },
  "x86_64-apple-darwin": { bun: "bun-darwin-x64", exe: false },
  "aarch64-apple-darwin": { bun: "bun-darwin-arm64", exe: false },
};

/** The triple Tauri will build for by default here, asked of rustc rather than guessed. */
function hostTriple(): string {
  const probe = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  // Without rustc there is nothing to build a Tauri app with anyway, but a clear message beats a
  // confusing one about an undefined triple.
  throw new Error("Could not determine the host target triple. Is the Rust toolchain installed?");
}

function build(triple: string): string {
  const target = TARGETS[triple];
  if (!target) {
    throw new Error(`No Bun target is mapped for ${triple}. Add it to TARGETS in ${"scripts/build-sidecar-binary.ts"}.`);
  }
  const outfile = join(OUT_DIR, `nova-sidecar-${triple}${target.exe ? ".exe" : ""}`);
  // Removed first: bun writes in place, and a stale binary left behind by a failed compile is
  // worse than none — it would package and then misbehave at runtime.
  rmSync(outfile, { force: true });

  const result = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", `--target=${target.bun}`, "--outfile", outfile],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`bun build failed for ${triple}`);
  if (!statSync(outfile, { throwIfNoEntry: false })) throw new Error(`bun build reported success but ${outfile} is missing`);
  return outfile;
}

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const triples = requested.length > 0 ? requested : [hostTriple()];

mkdirSync(OUT_DIR, { recursive: true });
for (const triple of triples) {
  const outfile = build(triple);
  const size = statSync(outfile).size;
  console.log(`nova-sidecar → ${outfile} (${(size / 1024 / 1024).toFixed(0)} MB, self-contained)`);
}
