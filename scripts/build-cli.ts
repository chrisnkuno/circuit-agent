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
  naming: "nova.js",
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const { launcher, main, bytes } = await emitCliBundle(OUT_DIR);
console.log(`built ${launcher} + ${path.basename(main)} (${(bytes / 1_000_000).toFixed(2)} MB)`);
