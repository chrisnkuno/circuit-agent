import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * How the CLI bundle is written to disk, in one place.
 *
 * Two build scripts emit this artifact — `build-cli.ts` for a local run and `build-packages.ts` for
 * the published package — and they each carried their own copy of the shebang rewrite. The copies
 * were identical until one of them gained a startup optimisation and the other did not, so the
 * thing users install was the one that missed it. There is only one copy now.
 */

/**
 * Both files are `.mjs`, and that is not cosmetic.
 *
 * `packages/nova-cli/package.json` declares `"type": "module"` while the repository root does not,
 * so a `.js` file means ES modules in one output directory and CommonJS in the other — and this
 * launcher is emitted to both. A CommonJS launcher ran fine from the root build and died in the
 * published one with `require is not defined in ES module scope`, which is the shipped artifact and
 * the only one that matters. `.mjs` is ESM wherever it lands, so the two builds cannot disagree.
 */
const LAUNCHER_NAME = "nova.mjs";
const MAIN_NAME = "nova-main.mjs";
/** The bundler writes here first; the launcher then replaces it. */
const BUNDLE_NAME = "nova.js";

/**
 * The published entry point, kept deliberately tiny.
 *
 * V8 spends roughly a third of Nova's startup compiling the ~3 MB bundle, and repeats that work on
 * every invocation. `enableCompileCache()` makes it write the compiled bytecode once and reuse it —
 * measured at about 14% off `nova --version` and 18% off a whole turn.
 *
 * It must live in a separate file because the call only affects modules loaded *after* it: a line
 * at the top of the bundle would be compiled as part of the very bundle it was meant to cache. So
 * this launcher stays small enough that compiling it costs nothing, and the expensive half arrives
 * through a dynamic import the cache does cover.
 *
 * Everything is guarded. The API landed in Node 22.1 and `engines` already requires 22.5, but a
 * read-only or full cache directory throws, and none of that is a reason for the CLI not to start:
 * a failure here gives up the optimisation and runs exactly as before.
 */
const LAUNCHER = `#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import path from "node:path";

try {
  enableCompileCache(process.env.NOVA_COMPILE_CACHE_DIR || undefined);
} catch {}

// argv[1] must name the module that is really executing. nova.ts decides whether to run main() by
// comparing its own import.meta.url against it, so leaving argv[1] pointing at this launcher makes
// the CLI import cleanly, run nothing, and exit 0 — the exact silent no-op its own comment warns
// about for symlinked installs. Rewriting it keeps that check true rather than adding a second way
// to say "this is the entry point" that could disagree with the first.
process.argv[1] = path.join(import.meta.dirname, ${JSON.stringify(MAIN_NAME)});

// Dynamic, so it is evaluated after the cache is enabled — a static import would be hoisted above
// it and compile the expensive half before there was anywhere to cache it.
await import("./${MAIN_NAME}");
`;

/**
 * Rewrites a freshly bundled `nova.js` into the launcher plus `nova-main.mjs`.
 *
 * The `.mjs` extension is load-bearing: the bundle is ES modules, and without it Node has to guess
 * from a package.json that is not there, warns about it, and reparses the whole file — a real cost
 * on the exact path this is meant to make cheaper.
 */
export async function emitCliBundle(outputDirectory: string): Promise<{ launcher: string; main: string; bytes: number }> {
  const bundled = path.join(outputDirectory, BUNDLE_NAME);
  const launcher = path.join(outputDirectory, LAUNCHER_NAME);
  const main = path.join(outputDirectory, MAIN_NAME);

  const bundle = await fs.readFile(bundled, "utf8");
  // Drop every leading shebang or bundler marker, then add exactly one Node shebang.
  const body = bundle.replace(/^(#![^\n]*\n|\/\/ @bun\n)+/, "");
  await fs.writeFile(main, `#!/usr/bin/env node\n${body}`, "utf8");
  await fs.chmod(main, 0o755);
  await fs.writeFile(launcher, LAUNCHER, "utf8");
  await fs.chmod(launcher, 0o755);
  // The bundler's own output name is not one of the two files that ship; leaving it behind would
  // put a third, stale copy of the whole CLI in the published tarball.
  await fs.rm(bundled, { force: true });

  return { launcher, main, bytes: (await fs.stat(main)).size };
}
