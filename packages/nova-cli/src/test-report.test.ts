import { describe, expect, it } from "vitest";
import { groupBySuite, parseTestOutput, renderTestReport } from "./test-report";
import { visibleWidth } from "./markdown";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 76): SectionStyle => ({ width, depth: "none" });

const VITEST = `
 RUN  v3.2.7 /repo

 ✓ src/money.test.ts (12 tests) 32ms
 ❯ src/agent.test.ts (8 tests | 1 failed) 210ms
   ✓ records a turn 4ms
   × refuses an unpriced budget 12ms

 FAIL  src/agent.test.ts > agent > refuses an unpriced budget
AssertionError: expected 1 to be 2

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 19 passed (20)
   Duration  1.42s
`;

const JEST = `
PASS src/a.test.js
FAIL src/b.test.js
  ● b › does the thing

    expected true to be false

Tests:       1 failed, 5 passed, 6 total
Time:        2.1s
`;

const PYTEST = `
tests/test_money.py::test_add PASSED
tests/test_money.py::test_convert FAILED
tests/test_cli.py::test_help SKIPPED

_______________ test_convert _______________
E   AssertionError: 3 != 4

======== 1 failed, 1 passed, 1 skipped in 0.42s ========
`;

const GO = `
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestConvert
--- FAIL: TestConvert (0.01s)
    money_test.go:14: got 3, want 4
FAIL
`;

const CARGO = `
running 3 tests
test money::adds ... ok
test money::converts ... FAILED
test money::ignores ... ignored

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured
`;

const TAP = `
TAP version 13
1..3
ok 1 - adds
not ok 2 - converts
ok 3 - skips # SKIP not today
`;

describe("reading test output", () => {
  it("reads a vitest run, its per-file counts and its failure", () => {
    const report = parseTestOutput(VITEST);
    expect(report?.framework).toBe("vitest");
    expect(report?.totals).toEqual({ passed: 19, failed: 1, skipped: 0, total: 20 });
    expect(report?.failures.map((failure) => failure.name).join(" ")).toContain("refuses an unpriced budget");
  });

  it("reads a jest run", () => {
    const report = parseTestOutput(JEST);
    expect(report?.totals.failed).toBe(1);
    expect(report?.totals.passed).toBe(5);
    expect(report?.totals.total).toBe(6);
  });

  it("reads pytest, including the skip and the assertion detail", () => {
    const report = parseTestOutput(PYTEST);
    expect(report?.framework).toBe("pytest");
    expect(report?.totals).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(report?.failures[0]?.lines.join(" ")).toContain("3 != 4");
  });

  it("reads go test, and keeps the failing file and line", () => {
    const report = parseTestOutput(GO);
    expect(report?.framework).toBe("go test");
    expect(report?.totals.passed).toBe(1);
    expect(report?.totals.failed).toBe(1);
    expect(report?.failures[0]?.lines.join(" ")).toContain("money_test.go:14");
  });

  it("reads cargo test, whose totals live in one summary line", () => {
    const report = parseTestOutput(CARGO);
    expect(report?.framework).toBe("cargo test");
    expect(report?.totals).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
  });

  it("reads TAP, and counts a SKIP as skipped rather than as a pass", () => {
    const report = parseTestOutput(TAP);
    expect(report?.framework).toBe("tap");
    expect(report?.totals).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
  });

  it("returns null for output that is not a test run at all, so ordinary commands print unchanged", () => {
    expect(parseTestOutput("exit 0")).toBeNull();
    expect(parseTestOutput("Compiled successfully in 1.2s\nBundle: 412kb")).toBeNull();
    expect(parseTestOutput("")).toBeNull();
  });

  it("never reports totals that contradict themselves", () => {
    for (const output of [VITEST, JEST, PYTEST, GO, CARGO, TAP]) {
      const report = parseTestOutput(output)!;
      expect(report.totals.total).toBeGreaterThanOrEqual(report.totals.failed);
      expect(report.totals.passed + report.totals.failed + report.totals.skipped).toBeLessThanOrEqual(report.totals.total);
    }
  });
});

describe("grouping", () => {
  it("puts failing files first, because that is what the reader is looking for", () => {
    const report = parseTestOutput(PYTEST)!;
    const groups = groupBySuite(report.cases);
    expect(groups[0].failed).toBeGreaterThan(0);
  });
});

describe("rendering a report", () => {
  it("separates the run with rules at both ends, so it reads as an episode", () => {
    const rendered = plain(renderTestReport(parseTestOutput(VITEST)!, style()));
    const ruleLines = rendered.split("\n").filter((line) => /─{4,}/.test(line));
    expect(ruleLines.length).toBeGreaterThanOrEqual(2);
    expect(rendered).toContain("tests");
  });

  it("names the failing test rather than only counting it", () => {
    const rendered = plain(renderTestReport(parseTestOutput(PYTEST)!, style()));
    expect(rendered).toContain("test_convert");
    expect(rendered).toContain("3 != 4");
  });

  it("says failed on the closing rule of a failing run, and passed on a clean one", () => {
    const failing = plain(renderTestReport(parseTestOutput(GO)!, style()));
    expect(failing).toContain("failed");
    const clean = plain(renderTestReport(parseTestOutput("test a ... ok\ntest result: ok. 1 passed; 0 failed;")!, style()));
    expect(clean).toContain("passed");
    expect(clean).not.toMatch(/\b1 failed\b/);
  });

  it("never draws past the width it was given", () => {
    for (const width of [30, 50, 100]) {
      const rendered = plain(renderTestReport(parseTestOutput(VITEST)!, style(width)));
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("caps the failure detail it prints and says how much it held back", () => {
    const report = parseTestOutput(PYTEST)!;
    report.failures[0].lines = Array.from({ length: 30 }, (_unused, index) => `detail ${index}`);
    const rendered = plain(renderTestReport(report, style(), { maxFailureLines: 3, expandHint: "/expand" }));
    expect(rendered).toContain("detail 2");
    expect(rendered).not.toContain("detail 9");
    expect(rendered).toContain("27 more lines");
  });
});
