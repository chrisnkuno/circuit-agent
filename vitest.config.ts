import { defineConfig } from "vitest/config";

/**
 * The suite runs under two runners, on purpose.
 *
 * `bun test` (see bunfig.toml) is scoped to `src/` because its `happydom.ts` preload registers a
 * DOM globally — and the Anthropic SDK inside nova-core refuses to construct a client when it sees
 * `window`, which makes the sidecar's own tests unrunnable under that preload.
 *
 * Vitest is the runner that covers everything, sidecar included: component tests opt into a DOM
 * per-file with `@vitest-environment happy-dom` rather than globally. `bun run test` is this one,
 * and it is what CI gates on.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "sidecar/src/**/*.test.ts"],
  },
});
