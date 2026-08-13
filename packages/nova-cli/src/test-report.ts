import { BOLD, DIM, GREEN, RED, YELLOW, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS } from "./glyphs";
import { GUTTER, clip, outcomeMark, rule, type SectionStyle } from "./sections";
import { visibleWidth } from "./markdown";

/**
 * Test output, read as a result rather than as a wall of text.
 *
 * Running the suite is the single most common thing an agent does with `run_command`, and the raw
 * output of a test runner is the single worst-shaped thing to paste into a transcript: hundreds of
 * lines, the one failure that matters buried in the middle, and no visual break between it and the
 * model's next paragraph. The summary line the transcript used to show (`exit 1 · 3 failed`) is
 * true and unusable — it names a number and hides the name of what broke.
 *
 * So the output is parsed into cases and grouped into files, and rendered as sections separated by
 * rules: what ran, what failed and why, and the totals. Failures are never folded; passes are, in
 * bulk, because "the other 212 passed" is one fact and not 212.
 *
 * Every parser here is line-based and forgiving. A test runner's format is not a contract, so a
 * missed line has to degrade to "not counted", never to a crash or a wrong total — and when
 * nothing test-shaped is found at all, `parseTestOutput` returns null and the caller prints the
 * command output exactly as it always did.
 */

export type CaseOutcome = "pass" | "fail" | "skip";

export type TestCase = {
  name: string;
  outcome: CaseOutcome;
  /** The file or module the case belongs to, when the runner names one. */
  suite?: string;
  durationMs?: number;
};

export type TestFailure = { name: string; lines: string[] };

export type TestReport = {
  framework: string;
  cases: TestCase[];
  totals: { passed: number; failed: number; skipped: number; total: number };
  failures: TestFailure[];
  durationMs?: number;
};

/** Symbols runners use for a passing / failing / skipped case, Unicode and ASCII forms alike. */
const PASS_MARK = /^[\s|]*(?:✓|✔|√|PASS(?:ED)?|ok)\s/;
const FAIL_MARK = /^[\s|]*(?:✕|✗|×|❯|FAIL(?:ED)?|not ok)\s/;
const SKIP_MARK = /^[\s|]*(?:↓|-|○|SKIP(?:PED)?|s)\s/;

function toMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([\d.]+)\s*(ms|s|m)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === "ms" ? amount : match[2] === "s" ? amount * 1_000 : amount * 60_000;
}

/** Everything a runner prints that is decoration rather than information. */
function clean(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trimEnd();
}

type Parsed = { cases: TestCase[]; failures: TestFailure[]; totals?: TestReport["totals"]; durationMs?: number; framework?: string };

/**
 * Vitest and Jest, which share enough shape to share a parser: a per-file line marked with a
 * symbol or `PASS`/`FAIL`, indented per-case lines under it, and a `Tests:` summary.
 */
function parseJavaScript(lines: readonly string[]): Parsed {
  const cases: TestCase[] = [];
  const failures: TestFailure[] = [];
  let framework: string | undefined;
  let totals: TestReport["totals"] | undefined;
  let durationMs: number | undefined;
  let currentSuite: string | undefined;
  let collecting: TestFailure | undefined;

  for (const raw of lines) {
    const line = clean(raw);
    if (/^\s*(?:RUN|DEV)\s+v\d|vitest/i.test(line)) framework ??= "vitest";
    if (/^\s*(?:PASS|FAIL)\s/.test(line)) framework ??= "jest";

    // A failure header names a test *inside* a file — "FAIL src/a.test.ts > agent > refuses …" —
    // and starts with the same marks a file-level line does. It is recognised first, or the file
    // branch below swallows it and the failure is counted but never named.
    const failureHeader = /^[\s|]*(?:FAIL|●|×|✕)\s+(.+?)\s*$/.exec(line);
    if (failureHeader && /[>›]/.test(failureHeader[1])) {
      collecting = { name: failureHeader[1].trim(), lines: [] };
      failures.push(collecting);
      continue;
    }

    // A file-level line: "✓ src/a.test.ts (12 tests) 32ms" or "FAIL src/a.test.ts".
    const file = /^[\s|]*(?:✓|✔|×|✕|✗|❯|PASS|FAIL)\s+(\S+\.(?:test|spec)\.\w+|\S+_test\.\w+)\s*(?:\((\d+)\s*tests?\))?\s*([\d.]+\s*m?s)?/.exec(line);
    if (file) {
      currentSuite = file[1];
      const failed = /^[\s|]*(?:×|✕|✗|❯|FAIL)/.test(line);
      // Recorded as one case per file only when the runner gave a count; otherwise the indented
      // per-case lines below carry the detail and counting the file too would double it.
      if (file[2]) {
        const count = Number(file[2]);
        for (let index = 0; index < count; index += 1) {
          cases.push({ name: `${file[1]} #${index + 1}`, outcome: failed ? "fail" : "pass", suite: file[1] });
        }
      } else {
        cases.push({ name: file[1], outcome: failed ? "fail" : "pass", suite: file[1], ...(toMs(file[3]) === undefined ? {} : { durationMs: toMs(file[3]) }) });
      }
      continue;
    }

    // An indented per-case line under a file.
    const testCase = /^\s{2,}(?:(✓|✔)|(×|✕|✗)|(↓|-|○))\s+(.+?)\s*(?:([\d.]+\s*m?s))?$/.exec(line);
    if (testCase) {
      const outcome: CaseOutcome = testCase[1] ? "pass" : testCase[2] ? "fail" : "skip";
      const duration = toMs(testCase[5]);
      cases.push({
        name: testCase[4].trim(),
        outcome,
        ...(currentSuite ? { suite: currentSuite } : {}),
        ...(duration === undefined ? {} : { durationMs: duration }),
      });
      continue;
    }

    if (collecting) {
      if (line.trim() === "" && collecting.lines.length > 0) collecting = undefined;
      else if (line.trim() !== "") collecting.lines.push(line.trim());
    }

    const summary = /Tests\s*[:\s]\s*(.+)$/.exec(line);
    if (summary) {
      const passed = Number(/(\d+)\s*passed/.exec(summary[1])?.[1] ?? 0);
      const failed = Number(/(\d+)\s*failed/.exec(summary[1])?.[1] ?? 0);
      const skipped = Number(/(\d+)\s*(?:skipped|todo|pending)/.exec(summary[1])?.[1] ?? 0);
      const total = Number(/\((\d+)\)/.exec(summary[1])?.[1] ?? /(\d+)\s*total/.exec(summary[1])?.[1] ?? passed + failed + skipped);
      totals = { passed, failed, skipped, total };
    }
    const duration = /^\s*(?:Duration|Time)\s*[:\s]\s*([\d.]+\s*m?s)/.exec(line);
    if (duration) durationMs = toMs(duration[1]);
  }

  return { cases, failures, ...(totals ? { totals } : {}), ...(durationMs === undefined ? {} : { durationMs }), ...(framework ? { framework } : {}) };
}

/** pytest: `tests/test_a.py::test_x PASSED`, plus the `=== 3 passed in 0.4s ===` tail. */
function parsePytest(lines: readonly string[]): Parsed {
  const cases: TestCase[] = [];
  const failures: TestFailure[] = [];
  let totals: TestReport["totals"] | undefined;
  let durationMs: number | undefined;
  let collecting: TestFailure | undefined;

  for (const raw of lines) {
    const line = clean(raw);
    const match = /^(\S+\.py)::(\S+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)/.exec(line);
    if (match) {
      const outcome: CaseOutcome = match[3] === "PASSED" || match[3] === "XPASS" ? "pass" : match[3] === "SKIPPED" || match[3] === "XFAIL" ? "skip" : "fail";
      cases.push({ name: match[2], outcome, suite: match[1] });
      continue;
    }
    const failureHeader = /^_{3,}\s+(.+?)\s+_{3,}$/.exec(line);
    if (failureHeader) {
      collecting = { name: failureHeader[1].trim(), lines: [] };
      failures.push(collecting);
      continue;
    }
    if (collecting && /^E\s+(.*)$/.test(line)) collecting.lines.push(line.replace(/^E\s+/, ""));

    const summary = /^=+\s*(.*?(?:passed|failed|error).*?)\s*=+$/.exec(line);
    if (summary) {
      const passed = Number(/(\d+)\s*passed/.exec(summary[1])?.[1] ?? 0);
      const failed = Number(/(\d+)\s*(?:failed|error)/.exec(summary[1])?.[1] ?? 0);
      const skipped = Number(/(\d+)\s*(?:skipped|deselected)/.exec(summary[1])?.[1] ?? 0);
      totals = { passed, failed, skipped, total: passed + failed + skipped };
      durationMs = toMs(/in\s+([\d.]+s)/.exec(summary[1])?.[1]);
    }
  }
  return { cases, failures, ...(totals ? { totals } : {}), ...(durationMs === undefined ? {} : { durationMs }), framework: cases.length > 0 || totals ? "pytest" : undefined };
}

/** `go test -v`: `--- PASS: TestThing (0.00s)` under `=== RUN`. */
function parseGo(lines: readonly string[]): Parsed {
  const cases: TestCase[] = [];
  const failures: TestFailure[] = [];
  let collecting: TestFailure | undefined;

  for (const raw of lines) {
    const line = clean(raw);
    const match = /^\s*---\s+(PASS|FAIL|SKIP):\s+(\S+)\s*(?:\(([\d.]+)s\))?/.exec(line);
    if (match) {
      const outcome: CaseOutcome = match[1] === "PASS" ? "pass" : match[1] === "SKIP" ? "skip" : "fail";
      const duration = match[3] ? Number(match[3]) * 1_000 : undefined;
      cases.push({ name: match[2], outcome, ...(duration === undefined ? {} : { durationMs: duration }) });
      collecting = outcome === "fail" ? { name: match[2], lines: [] } : undefined;
      if (collecting) failures.push(collecting);
      continue;
    }
    if (collecting && /^\s{4,}\S/.test(line)) collecting.lines.push(line.trim());
  }
  return { cases, failures, framework: cases.length > 0 ? "go test" : undefined };
}

/** cargo/rustc: `test module::name ... ok`, then `test result: FAILED. 2 passed; 1 failed;`. */
function parseCargo(lines: readonly string[]): Parsed {
  const cases: TestCase[] = [];
  let totals: TestReport["totals"] | undefined;

  for (const raw of lines) {
    const line = clean(raw);
    const match = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)/.exec(line);
    if (match) {
      cases.push({ name: match[1], outcome: match[2] === "ok" ? "pass" : match[2] === "ignored" ? "skip" : "fail" });
      continue;
    }
    const summary = /^test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;(?:\s*(\d+)\s+ignored)?/.exec(line);
    if (summary) {
      const passed = Number(summary[1]);
      const failed = Number(summary[2]);
      const skipped = Number(summary[3] ?? 0);
      totals = { passed, failed, skipped, total: passed + failed + skipped };
    }
  }
  return { cases, failures: [], ...(totals ? { totals } : {}), framework: cases.length > 0 || totals ? "cargo test" : undefined };
}

/** TAP, which several runners emit and which nothing else looks like. */
function parseTap(lines: readonly string[]): Parsed {
  const cases: TestCase[] = [];
  for (const raw of lines) {
    const line = clean(raw);
    const match = /^(not ok|ok)\s+(\d+)\s*[-–]?\s*(.*)$/.exec(line);
    if (!match) continue;
    const skipped = /#\s*(skip|todo)/i.test(match[3]);
    cases.push({
      name: match[3].replace(/#\s*(skip|todo).*$/i, "").trim() || `test ${match[2]}`,
      outcome: skipped ? "skip" : match[1] === "ok" ? "pass" : "fail",
    });
  }
  return { cases, failures: [], framework: cases.length > 0 ? "tap" : undefined };
}

/**
 * Reads whichever runner's output this is, or returns null when it is not test output at all.
 *
 * The parsers are run in order of how distinctive their formats are and the first one that finds
 * real evidence wins. "Evidence" means cases or a totals line — a command that merely printed the
 * word `ok` somewhere is not a test run, and treating it as one would replace a person's actual
 * command output with an empty report.
 */
export function parseTestOutput(output: string): TestReport | null {
  const lines = output.split("\n");
  if (lines.length === 0) return null;

  for (const parse of [parsePytest, parseGo, parseCargo, parseJavaScript, parseTap]) {
    const parsed = parse(lines);
    if (!parsed.framework) continue;
    if (parsed.cases.length === 0 && !parsed.totals) continue;
    const totals = parsed.totals ?? {
      passed: parsed.cases.filter((item) => item.outcome === "pass").length,
      failed: parsed.cases.filter((item) => item.outcome === "fail").length,
      skipped: parsed.cases.filter((item) => item.outcome === "skip").length,
      total: parsed.cases.length,
    };
    return {
      framework: parsed.framework,
      cases: parsed.cases,
      failures: parsed.failures.filter((failure) => failure.lines.length > 0),
      totals,
      ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
    };
  }
  return null;
}

/** Cases grouped by the file they came from, failing files first — the order a reader needs them. */
export function groupBySuite(cases: readonly TestCase[]): { suite: string; cases: TestCase[]; failed: number; passed: number; skipped: number }[] {
  const groups = new Map<string, TestCase[]>();
  for (const item of cases) {
    const key = item.suite ?? "";
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .map(([suite, items]) => ({
      suite,
      cases: items,
      failed: items.filter((item) => item.outcome === "fail").length,
      passed: items.filter((item) => item.outcome === "pass").length,
      skipped: items.filter((item) => item.outcome === "skip").length,
    }))
    .sort((left, right) => right.failed - left.failed || left.suite.localeCompare(right.suite));
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * The rendered report: a header rule, the suites, a failures section, and a totals rule.
 *
 * The rules are the point. A transcript is one long column, and a test run is an episode inside it
 * with a beginning and an end — without a break at each edge the eye cannot tell where the run
 * stopped and the model's commentary started, which is the exact confusion this replaces.
 */
export function renderTestReport(
  report: TestReport,
  style: SectionStyle,
  options: { maxSuites?: number; maxFailureLines?: number; expandHint?: string } = {},
): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const maxSuites = options.maxSuites ?? 10;
  const maxFailureLines = options.maxFailureLines ?? 6;
  const failing = report.totals.failed > 0;
  const out: string[] = [];

  out.push(rule(style, {
    label: `tests ${glyphs.middot} ${report.framework}`,
    tone: failing ? "bad" : "good",
  }));

  const groups = groupBySuite(report.cases).filter((group) => group.suite !== "" || group.cases.length > 0);
  const shown = groups.slice(0, maxSuites);
  const width = Math.max(0, ...shown.map((group) => visibleWidth(group.suite || "tests")));
  for (const group of shown) {
    const mark = outcomeMark(group.failed > 0 ? "fail" : group.passed === 0 ? "skip" : "pass", style);
    const counts = [
      group.passed > 0 ? `${group.passed} passed` : "",
      group.failed > 0 ? paint(`${group.failed} failed`, RED, style.depth) : "",
      group.skipped > 0 ? `${group.skipped} skipped` : "",
    ].filter(Boolean).join(` ${glyphs.middot} `);
    const name = (group.suite || "tests").padEnd(width + 2);
    // Budgeted as one row, with no floor that could push it past the edge: the counts are what must
    // survive, so the file name yields to them — but on a terminal too narrow for both, the counts
    // are clipped too rather than the row being allowed to overflow and wrap.
    const available = Math.max(0, style.width - GUTTER.length - 2);
    const countsShown = clip(counts, Math.max(0, available - 8), glyphs);
    const room = Math.max(0, available - visibleWidth(countsShown));
    out.push(`${GUTTER}${mark} ${clip(name, room, glyphs)}${paint(countsShown, DIM, style.depth)}`);
  }
  if (groups.length > shown.length) {
    out.push(`${GUTTER}${paint(`${glyphs.middot.repeat(3)} ${groups.length - shown.length} more file${groups.length - shown.length === 1 ? "" : "s"}`, DIM, style.depth)}`);
  }

  if (report.failures.length > 0) {
    out.push(rule(style, { label: `failures ${glyphs.middot} ${report.failures.length}`, tone: "bad" }));
    for (const failure of report.failures) {
      const name = clip(failure.name, Math.max(8, style.width - GUTTER.length - 2), glyphs);
      out.push(`${GUTTER}${paint(glyphs.cross, RED, style.depth)} ${paintAll(name, [BOLD], style.depth)}`);
      for (const line of failure.lines.slice(0, maxFailureLines)) {
        out.push(`${GUTTER}${GUTTER}${paint(clip(line, Math.max(8, style.width - 6), glyphs), DIM, style.depth)}`);
      }
      if (failure.lines.length > maxFailureLines) {
        const hidden = failure.lines.length - maxFailureLines;
        out.push(`${GUTTER}${GUTTER}${paint(`${glyphs.collapsed} ${hidden} more line${hidden === 1 ? "" : "s"}${options.expandHint ? ` — ${options.expandHint}` : ""}`, DIM, style.depth)}`);
      }
    }
  }

  const totals = [
    `${report.totals.total} test${report.totals.total === 1 ? "" : "s"}`,
    report.totals.passed > 0 ? paint(`${report.totals.passed} passed`, GREEN, style.depth) : "",
    report.totals.failed > 0 ? paint(`${report.totals.failed} failed`, RED, style.depth) : "",
    report.totals.skipped > 0 ? paint(`${report.totals.skipped} skipped`, YELLOW, style.depth) : "",
    formatDuration(report.durationMs),
  ].filter(Boolean).join(` ${glyphs.middot} `);
  out.push(rule(style, { label: failing ? "failed" : "passed", tone: failing ? "bad" : "good", trailing: totals }));

  return out.join("\n");
}
