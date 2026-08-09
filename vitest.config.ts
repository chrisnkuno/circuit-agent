import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Tests resolve the core package to its source, not its build output.
 *
 * The published `exports` map points at `dist`, which is what a consumer installing from npm needs.
 * Without this alias the suite would silently test whatever was last built — so a failing change
 * could pass simply because nobody had rebuilt, which is the worst possible failure mode for a
 * test suite.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@circuit-nova\/nova-core$/, replacement: path.resolve(__dirname, "packages/agent-core/src/index.ts") },
      { find: /^@circuit-nova\/nova-core\/(.*)$/, replacement: path.resolve(__dirname, "packages/agent-core/src/$1.ts") },
    ],
  },
  test: {
    coverage: {
      provider: "v8",
      // Scoped to hand-written package source. `dist/` is Bun.build's bundled output (one file,
      // tens of thousands of lines, already a copy of code counted elsewhere) and `index.ts` is a
      // pure re-export barrel — both would either double-count or silently drag the number down
      // without reflecting anything a test could meaningfully add.
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/index.ts",
        "packages/*/dist/**",
        // Pure type/interface declarations with no runtime statements — 0% is meaningless there,
        // not a gap a test could close.
        "packages/agent-core/src/providers/contracts.ts",
        "packages/agent-core/src/providers/model.ts",
      ],
    },
  },
});
