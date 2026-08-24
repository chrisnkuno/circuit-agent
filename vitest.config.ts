import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

/** The suites that drive a real terminal, kept out of the parallel pool. See `projects` below. */
const PTY_TESTS = "packages/nova-cli/src/pty/**/*.test.ts";

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
      {
        find: /^@circuit-nova\/nova-core$/,
        replacement: path.resolve(
          __dirname,
          "packages/agent-core/src/index.ts",
        ),
      },
      {
        find: /^@circuit-nova\/nova-core\/(.*)$/,
        replacement: path.resolve(__dirname, "packages/agent-core/src/$1.ts"),
      },
    ],
  },
  test: {
    // A worktree an isolated agent spawned into is a full, separate checkout of this same repo —
    // left in place, its tests double-run under a different name than vitest's defaults exclude,
    // and an in-progress worktree's half-finished code shouldn't gate this checkout's own suite
    // anyway. Extends vitest's own defaults rather than replacing them — `exclude` is not merged.
    exclude: [
      ...configDefaults.exclude,
      ".claude/worktrees/**",
      "reliability/site/runs/**",
      // Playwright drives a real browser against a running server; `bun run test:e2e` owns it.
      "apps/web/tests/e2e/**",
    ],
    /**
     * Terminal tests get the machine to themselves.
     *
     * The pty suites spawn a real `bun run nova.ts` per case — a 32,000-line transpile and a full
     * agent boot behind a pseudo-terminal — and they assert by *waiting* for a prompt to be
     * painted. Run alongside every other worker they lose the CPU race and time out, which reads
     * as a broken feature when it is only a busy machine: the same case passes on its own every
     * time. That made the whole suite fail intermittently at roughly one run in two, and a suite
     * that cries wolf every other run is one people stop reading.
     *
     * Splitting them into their own project lets that project run its files one at a time while
     * everything else stays fully parallel. It costs roughly a minute of wall time on the full
     * run — measured, not guessed — and two forks instead of one was tried and is worse than
     * either extreme: still contended enough to fail, and slower than serial when it retries.
     * A suite that is a minute quicker and wrong every other run is not the better trade.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "pty",
          include: [PTY_TESTS],
          // One worker for the whole project, so these files run one after another. `fileParallelism`
          // is a root-level option and is ignored here; `singleFork` is the per-project form of the
          // same idea and is the one that actually takes effect.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [
            ...configDefaults.exclude,
            ".claude/worktrees/**",
            "reliability/site/runs/**",
            "apps/web/tests/e2e/**",
            PTY_TESTS,
          ],
        },
      },
    ],
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
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
