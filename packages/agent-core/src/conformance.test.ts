import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The standards this package already holds, written down so they cannot erode.
 *
 * Everything asserted here was true when it was written. That is the point: a codebase does not
 * usually decay by someone deciding to lower the bar, it decays one reasonable-looking exception at
 * a time, and nothing is watching. "All tests pass" never catches it — a module with no test passes
 * every suite, an unexported module typechecks perfectly, and a swallowed error is invisible until
 * the night it matters.
 *
 * Two kinds of rule live here, and the difference is deliberate:
 *
 * - **Zero-tolerance rules** are properties the package holds completely today. They are asserted
 *   at zero, so the first violation fails rather than the hundredth.
 * - **Ratchets** are debts that exist. Each carries the count measured on the day it was recorded,
 *   and the count may only fall. Nobody has to stop and fix all of them to make progress, which is
 *   what makes this progressive rather than a wall — but nobody can quietly add to them either.
 *
 * Lowering a ratchet when you remove a debt is part of removing it. Raising one is a decision, and
 * it gets written down next to the number it replaced.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

type Module = { relative: string; text: string };

function sourceModules(): Module[] {
  const found: Module[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push({ relative: path.relative(packageRoot, absolute).split(path.sep).join("/"), text: readFileSync(absolute, "utf8") });
      }
    }
  };
  walk(packageRoot);
  return found;
}

function testModules(): Module[] {
  const found: Module[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".test.ts")) {
        found.push({ relative: path.relative(packageRoot, absolute).split(path.sep).join("/"), text: readFileSync(absolute, "utf8") });
      }
    }
  };
  walk(packageRoot);
  return found;
}

/** A module that exports only types cannot be executed, so no test can reference it at runtime. */
function isTypeOnly(module: Module): boolean {
  return !/export (async )?function |export class |export const |export enum |export \{/.test(module.text);
}

/** Counts non-overlapping matches without the state a global regex carries between calls. */
function count(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))?.length ?? 0;
}

describe("what this package refuses to let rot", () => {
  const sources = sourceModules();
  const tests = testModules();
  const allTestText = tests.map((module) => module.text).join("\n");

  it("has a test that exercises every module which can be executed", () => {
    // A module nothing imports is a module nothing checks, and it passes every suite in the repo.
    const unreferenced = sources
      .filter((module) => !isTypeOnly(module))
      .filter((module) => path.basename(module.relative) !== "index.ts")
      .filter((module) => {
        const name = path.basename(module.relative, ".ts");
        return !new RegExp(`from "(\\.{1,2}/)*([\\w./-]*/)?${name}"`).test(allTestText);
      })
      .map((module) => module.relative);
    expect(unreferenced).toEqual([]);
  });

  it("never swallows an error silently", () => {
    // An empty catch is a decision to continue without knowing what happened. Every catch in this
    // package either handles the failure or says in a comment why absence is the right answer.
    for (const module of sources) {
      expect(count(module.text, /catch\s*\{\s*\}/), module.relative).toBe(0);
    }
  });

  it("never writes to the console or kills the process from library code", () => {
    // This package is embedded — by the CLI, by the desktop sidecar, by the hosted worker. A stray
    // `console.log` corrupts a stdout protocol stream, and `process.exit` takes down its host.
    for (const module of sources) {
      expect(count(module.text, /\bconsole\.(log|info|warn|error|debug)\(/), module.relative).toBe(0);
      expect(count(module.text, /\bprocess\.exit\(/), module.relative).toBe(0);
    }
  });

  it("carries no suppressed type errors and no abandoned markers", () => {
    for (const module of sources) {
      expect(count(module.text, /@ts-(ignore|expect-error|nocheck)/), module.relative).toBe(0);
      // A TODO in shipped code is a decision someone deferred and nobody scheduled. The register
      // for known-and-not-done work is docs/reference/optimization-map.md, where it has an owner and a number.
      expect(count(module.text, /\b(TODO|FIXME|XXX|HACK)\b/), module.relative).toBe(0);
    }
  });

  /**
   * Escapes from the type system, counted.
   *
   * Not banned: the boundary with a vendor SDK sometimes genuinely needs one, and a rule that
   * cannot be satisfied honestly gets worked around. Counted, so the number can only fall — and so
   * that adding one is a visible act rather than a quiet one.
   */
  it("does not add type escapes faster than it removes them", () => {
    const budgets: Record<string, number> = {
      "as any": 4,
      "as unknown as": 7,
      "as never": 5,
    };
    const measured = {
      "as any": sources.reduce((total, module) => total + count(module.text, /\bas any\b/), 0),
      "as unknown as": sources.reduce((total, module) => total + count(module.text, /\bas unknown as\b/), 0),
      "as never": sources.reduce((total, module) => total + count(module.text, /\bas never\b/), 0),
    };
    for (const [escape, ceiling] of Object.entries(budgets)) {
      expect(measured[escape as keyof typeof measured], `${escape} (recorded 2026-08-22 at ${ceiling}; lower it when you remove one)`).toBeLessThanOrEqual(ceiling);
    }
  });

  /**
   * Every module opens by explaining itself, because that is how this codebase is written.
   *
   * A ratchet rather than a rule, because ten modules predate it. The comment that matters is not
   * "what this file contains" — the exports say that — it is why it exists, what it refused to do,
   * and which mistake it is standing in the way of.
   */
  it("does not add modules without a header comment", () => {
    const withoutHeader = sources.filter((module) => {
      const lines = module.text.split("\n");
      const opener = lines.slice(0, 60).findIndex((line) => line.trim().startsWith("/**"));
      if (opener === -1) return true;
      let close = opener;
      while (close < lines.length && !lines[close].includes("*/")) close += 1;
      return close - opener + 1 < 3;
    });
    // Recorded 2026-08-22 at 10. Write a header when you next touch one of these, and lower it.
    expect(withoutHeader.length, `modules without a header: ${withoutHeader.map((module) => module.relative).join(", ")}`).toBeLessThanOrEqual(10);
  });

  it("has no test file whose subject has been deleted or renamed", () => {
    // An orphaned test keeps passing against a module that no longer exists in the shape it tests.
    const sourceNames = new Set(sources.map((module) => module.relative));
    const orphans = tests
      .map((module) => module.relative.replace(/\.test\.ts$/, ".ts"))
      .filter((expected) => !sourceNames.has(expected))
      // These test a subject spread across several modules rather than one file of the same name.
      .filter((expected) => !["providers/truncation.ts", "providers/streaming.ts", "nova-cli/remember.ts", "nova-cli/adversarial-policy.ts", "nova-cli/workspace-conformance.ts", "nova-cli/migration.ts", "nova-cli/nested-instructions.ts", "nova-cli/auto-mode.ts", "conformance.ts"].includes(expected));
    expect(orphans).toEqual([]);
  });
});
