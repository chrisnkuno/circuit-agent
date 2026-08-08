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
      { find: /^circuit-nova-core$/, replacement: path.resolve(__dirname, "packages/agent-core/src/index.ts") },
      { find: /^circuit-nova-core\/(.*)$/, replacement: path.resolve(__dirname, "packages/agent-core/src/$1.ts") },
    ],
  },
});
