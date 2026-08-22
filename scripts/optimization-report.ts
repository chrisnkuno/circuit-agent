#!/usr/bin/env bun
/**
 * The optimization map, measured against the code as it stands right now.
 *
 * `bun run optimize:map` prints every target, what it measures today, and whether that is inside
 * its budget. The same registry is asserted by the test suite, so this script never disagrees with
 * CI — it exists because a person (or Nova, reading its own output) wants the whole picture at
 * once, including the targets no probe covers yet, which a pass/fail suite has no reason to print.
 *
 * `--json` emits the same results as machine-readable records, which is the form an agent should
 * consume when deciding what to work on next.
 */
import { OPTIMIZATION_TARGETS, describeBudget, runOptimizationProbes } from "@circuit-nova/nova-core/nova-cli/optimization-map";

const asJson = process.argv.includes("--json");
const results = await runOptimizationProbes({ root: process.cwd() });

if (asJson) {
  console.log(JSON.stringify(
    results.map((result) => ({
      id: result.target.id,
      layer: result.target.layer,
      status: result.status,
      measured: result.measured ?? null,
      metric: result.target.metric,
      budget: result.target.budget,
      baseline: result.target.baseline ?? null,
      what: result.target.what,
      evidence: result.target.evidence,
      remediation: result.target.remediation,
    })),
    null,
    2,
  ));
} else {
  const mark = { pass: "ok  ", fail: "FAIL", unmeasured: "--  ", error: "ERR " } as const;
  let layer = "";
  for (const result of results) {
    if (result.target.layer !== layer) {
      layer = result.target.layer;
      console.log(`\n${layer.toUpperCase()}`);
    }
    const measured = result.measured === undefined ? "—" : String(Math.round(result.measured * 1_000) / 1_000);
    const baseline = result.target.baseline ? ` (was ${result.target.baseline.value} on ${result.target.baseline.on})` : "";
    console.log(`  ${mark[result.status]} ${result.target.id.padEnd(38)} ${measured.padStart(10)}  ${describeBudget(result.target)}${baseline}`);
    if (result.status === "fail" || result.status === "error") console.log(`       → ${result.target.remediation}`);
  }
  const failed = results.filter((result) => result.status === "fail" || result.status === "error").length;
  const unmeasured = results.filter((result) => result.status === "unmeasured").length;
  console.log(`\n${results.length - failed - unmeasured} within budget, ${failed} over, ${unmeasured} not yet probed (of ${OPTIMIZATION_TARGETS.length}).`);
  if (failed > 0) process.exitCode = 1;
}
