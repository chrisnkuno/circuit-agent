import path from "node:path";
import { emitCliBundle } from "./cli-bundle";

/**
 * Bundles Nova CLI for Node.
 *
 * The bundler preserves the entry file's own `#!/usr/bin/env bun` line, so passing a Node shebang
 * as a banner produces a file with two of them — and the second one is a syntax error, because a
 * shebang is only special on the first line. Building plain and rewriting the header afterwards is
 * the only ordering that yields one shebang, and it keeps the source directly runnable under Bun
 * during development.
 */

const OUT_DIR = "dist";

// Declared rather than pulled from @types/bun: this build script is the only Bun-specific file in
// the project, and one narrow declaration is cheaper than a dependency for the whole typecheck.
declare const Bun: { build(options: Record<string, unknown>): Promise<{ success: boolean; logs: unknown[] }> };

const built = await Bun.build({
  entrypoints: ["packages/nova-cli/src/nova.ts"],
  target: "node",
  outdir: OUT_DIR,
  // Code splitting, and it is not cosmetic. Without it Bun hoists every dynamically imported
  // subtree into the entry file, so `await import("./providers/factory")` bought nothing: the
  // OpenAI, Anthropic and zod runtimes all executed on `nova --help`. Measured on the instrumented
  // bundle, 510 of 755 module sections ran before the prompt could be drawn. Splitting moves the
  // provider subtree into its own chunk that is loaded only when a model is actually constructed —
  // entry 3.90 MB -> 0.94 MB, and `--help` from 205ms to 110ms with the compile cache still on.
  //
  // Chunks are named `.mjs` deliberately: `dist/` has no package.json in the local build, so a
  // `.js` chunk would be read as CommonJS by Node and fail the moment the ESM entry imported it.
  // The same trap the launcher's own comment describes, one level down.
  splitting: true,
  naming: { entry: "nova.js", chunk: "[name]-[hash].mjs" },
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const { launcher, main, bytes } = await emitCliBundle(OUT_DIR);
console.log(`built ${launcher} + ${path.basename(main)} (${(bytes / 1_000_000).toFixed(2)} MB)`);
