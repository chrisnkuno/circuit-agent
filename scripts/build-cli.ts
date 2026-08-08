import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Bundles Nova CLI for Node.
 *
 * The bundler preserves the entry file's own `#!/usr/bin/env bun` line, so passing a Node shebang
 * as a banner produces a file with two of them — and the second one is a syntax error, because a
 * shebang is only special on the first line. Building plain and rewriting the header afterwards is
 * the only ordering that yields one shebang, and it keeps the source directly runnable under Bun
 * during development.
 */

const OUTPUT = path.join("dist", "nova.js");

// Declared rather than pulled from @types/bun: this build script is the only Bun-specific file in
// the project, and one narrow declaration is cheaper than a dependency for the whole typecheck.
declare const Bun: { build(options: Record<string, unknown>): Promise<{ success: boolean; logs: unknown[] }> };

const built = await Bun.build({
  entrypoints: ["packages/nova-cli/src/nova.ts"],
  target: "node",
  outdir: "dist",
  naming: "nova.js",
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

const bundle = await fs.readFile(OUTPUT, "utf8");
// Drop every leading shebang or bundler marker, then add exactly one Node shebang.
const body = bundle.replace(/^(#![^\n]*\n|\/\/ @bun\n)+/, "");
await fs.writeFile(OUTPUT, `#!/usr/bin/env node\n${body}`, "utf8");
await fs.chmod(OUTPUT, 0o755);

const { size } = await fs.stat(OUTPUT);
console.log(`built ${OUTPUT} (${(size / 1_000_000).toFixed(2)} MB)`);
