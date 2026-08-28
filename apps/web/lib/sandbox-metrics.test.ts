import { describe, expect, it } from "vitest";
import {
  billingEfficiency, clamp01, DEFAULT_SHAPE, formatMs, formatUsd, mean, median, percent, PRESSURE_WEIGHTS,
  quantile, ratio, runStatistics, shapeOf, slopePerMinute, stepDurations, usdForBilledMs,
  usdPerHour, utilization, USD_PER_GIB_SECOND, USD_PER_VCPU_SECOND, type MetricSample, type StepSample,
} from "./sandbox-metrics";

const sample: MetricSample = { cpuUsedPct: 50, cpuCount: 2, memUsed: 512, memTotal: 1_024, diskUsed: 100, diskTotal: 1_000 };

describe("clamp01 and ratio", () => {
  it("never lets a ratio leave 0..1, whatever the inputs are", () => {
    // Every bar width on the panel is one of these, so an out-of-range value is a broken layout.
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(4)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(9, 4)).toBe(1);
  });

  it("answers zero rather than NaN or Infinity when nothing has been measured", () => {
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(Number.NaN, 10)).toBe(0);
  });
});

describe("quantile", () => {
  it("interpolates the way a spreadsheet does, so a p95 quoted here matches one computed there", () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20], 0.95)).toBeCloseTo(19.5, 10);
  });

  it("does not reorder the caller's array", () => {
    const values = [5, 1, 3];
    expect(median(values)).toBe(3);
    expect(values).toEqual([5, 1, 3]);
  });

  it("is zero for an empty sample rather than NaN", () => {
    expect(quantile([], 0.9)).toBe(0);
    expect(mean([])).toBe(0);
  });
});

describe("slopePerMinute", () => {
  it("reports a rising series as positive and a falling one as negative, per minute", () => {
    const rising = [{ t: 0, v: 0 }, { t: 60_000, v: 10 }, { t: 120_000, v: 20 }];
    expect(slopePerMinute(rising)).toBeCloseTo(10, 10);
    expect(slopePerMinute(rising.map((point) => ({ ...point, v: -point.v })))).toBeCloseTo(-10, 10);
  });

  it("calls a series with no spread flat instead of dividing by zero", () => {
    expect(slopePerMinute([])).toBe(0);
    expect(slopePerMinute([{ t: 5, v: 9 }])).toBe(0);
    expect(slopePerMinute([{ t: 5, v: 1 }, { t: 5, v: 9 }])).toBe(0);
  });
});

describe("utilization", () => {
  it("turns a provider sample into three ratios and one weighted composite", () => {
    const load = utilization(sample);
    expect(load).toMatchObject({ cpu: 0.5, memory: 0.5, disk: 0.1 });
    expect(load.pressure).toBeCloseTo(0.5 * PRESSURE_WEIGHTS.cpu + 0.5 * PRESSURE_WEIGHTS.memory + 0.1 * PRESSURE_WEIGHTS.disk, 10);
  });

  it("keeps the weights summing to one, so pressure is itself a ratio", () => {
    expect(PRESSURE_WEIGHTS.cpu + PRESSURE_WEIGHTS.memory + PRESSURE_WEIGHTS.disk).toBeCloseTo(1, 10);
    expect(utilization({ cpuUsedPct: 100, cpuCount: 4, memUsed: 8, memTotal: 8, diskUsed: 9, diskTotal: 9 }).pressure).toBe(1);
    expect(utilization({ cpuUsedPct: 0, cpuCount: 4, memUsed: 0, memTotal: 8, diskUsed: 0, diskTotal: 9 }).pressure).toBe(0);
  });

  it("survives a sample with no totals, which is what a just-started sandbox reports", () => {
    expect(utilization({ cpuUsedPct: 0, cpuCount: 0, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0 }))
      .toEqual({ cpu: 0, memory: 0, disk: 0, pressure: 0 });
  });
});

describe("cost", () => {
  it("prices a sandbox from its own shape, not from an assumed default", () => {
    expect(usdPerHour({ cpuCount: 2, memGib: 0.5 })).toBeCloseTo((2 * USD_PER_VCPU_SECOND + 0.5 * USD_PER_GIB_SECOND) * 3_600, 10);
    // Twice the CPU and twice the RAM is exactly twice the rate — the units are linear.
    expect(usdPerHour({ cpuCount: 4, memGib: 1 })).toBeCloseTo(usdPerHour({ cpuCount: 2, memGib: 0.5 }) * 2, 10);
  });

  it("bills only the time a step held the machine", () => {
    const hourly = usdPerHour(DEFAULT_SHAPE);
    expect(usdForBilledMs(3_600_000)).toBeCloseTo(hourly, 10);
    expect(usdForBilledMs(0)).toBe(0);
    expect(usdForBilledMs(-500)).toBe(0);
  });

  it("reads the shape off a live sample and falls back to the documented default without one", () => {
    expect(shapeOf({ ...sample, cpuCount: 4, memTotal: 2 * 1_073_741_824 })).toEqual({ cpuCount: 4, memGib: 2 });
    expect(shapeOf(undefined)).toEqual({ cpuCount: DEFAULT_SHAPE.cpuCount, memGib: DEFAULT_SHAPE.memGib });
    expect(shapeOf({ ...sample, cpuCount: 0, memTotal: 0 })).toEqual({ cpuCount: DEFAULT_SHAPE.cpuCount, memGib: DEFAULT_SHAPE.memGib });
  });
});

describe("billingEfficiency", () => {
  it("is the share of a sandbox's life that was actually billed", () => {
    expect(billingEfficiency(30_000, 120_000)).toBe(0.25);
    expect(billingEfficiency(0, 120_000)).toBe(0);
    // Billed time can never exceed wall time; a clock skew must not produce 340%.
    expect(billingEfficiency(500_000, 120_000)).toBe(1);
    expect(billingEfficiency(10, 0)).toBe(0);
  });
});

function step(overrides: Partial<StepSample> = {}): StepSample {
  return { status: "completed", attempts: 1, claimedAt: 0, completedAt: 10_000, ...overrides };
}

describe("runStatistics", () => {
  it("counts each outcome and derives duration, throughput, and progress together", () => {
    const stats = runStatistics([
      step({ completedAt: 10_000 }),
      step({ completedAt: 30_000 }),
      step({ status: "failed", attempts: 3, completedAt: 5_000 }),
      step({ status: "running", claimedAt: 1_000, completedAt: undefined }),
    ], 3_600_000);
    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.meanStepMs).toBeCloseTo(15_000, 10);
    expect(stats.throughputPerHour).toBeCloseTo(2, 10);
    expect(stats.successRate).toBeCloseTo(2 / 3, 10);
    expect(stats.retryRate).toBeCloseTo(0.5, 10);
    expect(stats.progress).toBe(0.5);
  });

  it("excludes undecided steps from the success rate rather than counting them as wins", () => {
    // A run whose steps are all still pending has no success rate to report, and reporting 100%
    // would tell someone a sandbox succeeded before it did anything.
    const pending = runStatistics([step({ status: "pending", claimedAt: undefined, completedAt: undefined })], 60_000);
    expect(pending.successRate).toBe(0);
    expect(pending.progress).toBe(0);
  });

  it("ignores a step whose clock ran backwards instead of recording a negative duration", () => {
    expect(stepDurations([step({ claimedAt: 10_000, completedAt: 1_000 })])).toEqual([]);
    expect(stepDurations([step({ claimedAt: undefined })])).toEqual([]);
    expect(stepDurations([step({ claimedAt: 2_000, completedAt: 2_000 })])).toEqual([0]);
  });

  it("is all zeros for a run with no steps and no window", () => {
    const empty = runStatistics([], 0);
    expect(empty).toMatchObject({ total: 0, completed: 0, meanStepMs: 0, p95StepMs: 0, throughputPerHour: 0, successRate: 0, retryRate: 0, progress: 0 });
  });
});

describe("formatting", () => {
  it("rounds a ratio to whole percent", () => {
    expect(percent(0.1734)).toBe(17);
    expect(percent(2)).toBe(100);
    expect(percent(-1)).toBe(0);
  });

  it("keeps sub-cent amounts legible and larger ones plain", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(-1)).toBe("$0");
    expect(formatUsd(0.0003)).toBe("$0.0003");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("shows one dominant unit at every scale", () => {
    expect(formatMs(0)).toBe("0s");
    expect(formatMs(450)).toBe("450ms");
    expect(formatMs(4_500)).toBe("4.5s");
    expect(formatMs(45_000)).toBe("45s");
    expect(formatMs(300_000)).toBe("5.0m");
    expect(formatMs(7_200_000)).toBe("2.0h");
  });
});
