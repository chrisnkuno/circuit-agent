import { promises as fs } from "node:fs";
import path from "node:path";
import { emitCliBundle } from "./cli-bundle";
import { fileURLToPath } from "node:url";

/**
 * Builds both packages into something npm can actually install.
 *
 * The core ships as mirrored ES modules plus declarations rather than one bundle, so a consumer can
 * import a single adapter without pulling the whole runtime. That shape has one sharp edge: Node's
 * ESM loader requires file extensions, and TypeScript emits the extensionless specifiers it was
 * given. The emitted files are rewritten below rather than the sources, because adding `.js` to
 * every import in a TypeScript codebase makes the source worse to read in exchange for nothing.
 *
 * The CLI ships as a single bundle with its dependencies inlined — an installed binary should not
 * be able to break because a transitive dependency resolved differently on someone else's machine.
 */

// Resolved from this file rather than the working directory: npm runs lifecycle scripts with the
// package as cwd, so anything relative breaks the moment `prepublishOnly` invokes it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORE = path.join(ROOT, "packages/agent-core");
const CLI = path.join(ROOT, "packages/nova-cli");
const DEFENDER_KNOWLEDGE = path.join(ROOT, "packages", "nova-state", "defender-knowledge");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ success: boolean; logs: unknown[] }>;
  spawn(command: string[], options: Record<string, unknown>): { exited: Promise<number> };
};

async function run(command: string[], cwd = ROOT): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

/** Walks a built tree and gives every relative import the extension Node insists on. */
async function addExtensions(directory: string): Promise<number> {
  let fixed = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      fixed += await addExtensions(full);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    const source = await fs.readFile(full, "utf8");
    const updated = source.replace(
      /(from\s+|import\(\s*)(["'])(\.[^"']*?)\2/g,
      (match, prefix: string, quote: string, spec: string) => {
        if (/\.(js|json|css)$/.test(spec)) return match;
        fixed += 1;
        return `${prefix}${quote}${spec}.js${quote}`;
      },
    );
    if (updated !== source) await fs.writeFile(full, updated, "utf8");
  }
  return fixed;
}

// The hosted control plane imports the core package but never the CLI, and its deploy upload
// deliberately omits the CLI's data inputs. `core` builds just what that deploy needs.
const coreOnly = process.argv.slice(2).includes("core");

await fs.rm(path.join(CORE, "dist"), { recursive: true, force: true });
if (!coreOnly) await fs.rm(path.join(CLI, "dist"), { recursive: true, force: true });

// 1. Core: JavaScript and declarations, mirroring the source layout.
// Invoking the JavaScript entry through the current Bun executable works on Windows too; the
// `.bin/tsc` POSIX shim used previously does not.
await run([process.execPath, TSC, "-p", "tsconfig.build.json"], CORE);
const rewritten = await addExtensions(path.join(CORE, "dist"));
await fs.cp(DEFENDER_KNOWLEDGE, path.join(CORE, "dist", "nova-cli", "defender-knowledge"), { recursive: true });
console.log(`agent-core: emitted modules and types, rewrote ${rewritten} import specifiers`);

// 2. CLI: one self-contained executable.
if (coreOnly) process.exit(0);
const built = await Bun.build({
  entrypoints: [path.join(CLI, "src", "nova.ts")],
  target: "node",
  outdir: path.join(CLI, "dist"),
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
  // TermUI stays outside the bundle on purpose. The workspace screen is reached through a dynamic
  // import, and inlining a 5 MB framework would put its parse cost back on every `nova --version`
  // — the startup path that has no screen and never will. Declared in `dependencies`, so npm has
  // installed it beside the bundle by the time anyone opens the workspace.
  external: ["@termuijs/core", "@termuijs/jsx", "@termuijs/widgets"],
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
// Defender knowledge is data, not code: keep it outside the bundle so it can be inspected,
// replaced, and indexed without putting the full corpus in every model request.
await fs.cp(DEFENDER_KNOWLEDGE, path.join(CLI, "dist", "defender-knowledge"), { recursive: true });
const { launcher, main, bytes } = await emitCliBundle(path.join(CLI, "dist"));
console.log(`nova-cli: built ${launcher} + ${path.basename(main)} (${(bytes / 1_000_000).toFixed(2)} MB)`);
