/**
 * The arithmetic behind the command center.
 *
 * Every number the panel shows is derived here rather than in a component or a Convex handler, so
 * the definitions are stated once and can be checked without a browser, a database, or a provider.
 * Two rules hold throughout: a ratio is always in 0..1 and clamped, and a rate is always expressed
 * per hour so figures compare across sandboxes of different ages.
 */

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Division that answers 0 for an empty denominator instead of NaN or Infinity. */
export function ratio(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return clamp01(part / whole);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * The linear-interpolated quantile of a sample, the same definition spreadsheets use, so a p95
 * quoted here matches a p95 computed anywhere else from the same numbers.
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp01(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/**
 * Least-squares slope of a time series, in units per minute.
 *
 * One sample cannot have a direction and two identical timestamps cannot either, so both answer
 * zero — a flat reading is the honest result, not a divide-by-zero.
 */
export function slopePerMinute(points: readonly { t: number; v: number }[]): number {
  if (points.length < 2) return 0;
  const meanT = mean(points.map((point) => point.t));
  const meanV = mean(points.map((point) => point.v));
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dt = point.t - meanT;
    covariance += dt * (point.v - meanV);
    variance += dt * dt;
  }
  if (variance === 0) return 0;
  return (covariance / variance) * 60_000;
}

/* -------------------------------------------------------------------- load */

export type MetricSample = {
  cpuUsedPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
};

export type Utilization = { cpu: number; memory: number; disk: number; pressure: number };

/**
 * CPU, memory, and disk as three ratios plus one composite.
 *
 * The composite is weighted 0.5 / 0.35 / 0.15: a sandbox that has run out of CPU is slow, one that
 * has run out of memory is killed, and one that has run out of disk usually still finishes the
 * step it is on. The weights sum to exactly 1, so pressure is itself a ratio and can drive a bar.
 */
export const PRESSURE_WEIGHTS = { cpu: 0.5, memory: 0.35, disk: 0.15 } as const;

export function utilization(sample: MetricSample): Utilization {
  const cpu = clamp01(sample.cpuUsedPct / 100);
  const memory = ratio(sample.memUsed, sample.memTotal);
  const disk = ratio(sample.diskUsed, sample.diskTotal);
  const pressure = clamp01(cpu * PRESSURE_WEIGHTS.cpu + memory * PRESSURE_WEIGHTS.memory + disk * PRESSURE_WEIGHTS.disk);
  return { cpu, memory, disk, pressure };
}

/* -------------------------------------------------------------------- cost */

/**
 * E2B's published unit rates: $0.000014 per vCPU-second and $0.0000045 per GiB-second of RAM.
 * Keeping the two units separate is what lets a differently shaped sandbox be priced correctly
 * rather than assumed to be the 2 vCPU / 512 MiB default.
 */
export const USD_PER_VCPU_SECOND = 0.000014;
export const USD_PER_GIB_SECOND = 0.0000045;
/**
 * The fallback shape, used only where no live sample exists (a paused sandbox, or an aggregate
 * over runs that have already finished). Measured from a real `circuit-next-web` sandbox rather
 * than assumed: E2B reported 2 vCPU and 0.95 GiB total memory, so pricing this at the older
 * 512 MiB default under-reported every historical figure.
 */
export const DEFAULT_SHAPE = { cpuCount: 2, memGib: 0.95 } as const;

export function usdPerHour(shape: { cpuCount: number; memGib: number }): number {
  const cpuCount = Math.max(0, shape.cpuCount);
  const memGib = Math.max(0, shape.memGib);
  return (cpuCount * USD_PER_VCPU_SECOND + memGib * USD_PER_GIB_SECOND) * 3_600;
}

/** Cost of time a step actually held the machine. Idle sandbox time is not billed. */
export function usdForBilledMs(billedMs: number, shape: { cpuCount: number; memGib: number } = DEFAULT_SHAPE): number {
  return Math.max(0, billedMs) / 3_600_000 * usdPerHour(shape);
}

export function shapeOf(sample: MetricSample | undefined): { cpuCount: number; memGib: number } {
  if (!sample || sample.cpuCount <= 0 || sample.memTotal <= 0) return { cpuCount: DEFAULT_SHAPE.cpuCount, memGib: DEFAULT_SHAPE.memGib };
  return { cpuCount: sample.cpuCount, memGib: sample.memTotal / 1_073_741_824 };
}

/**
 * Billed time over wall time.
 *
 * A run that spends most of its life suspended between steps has low efficiency and a low bill;
 * one pinned near 1 is holding a machine for its whole existence. It is a diagnostic, not a score.
 */
export function billingEfficiency(billedMs: number, uptimeMs: number): number {
  return ratio(billedMs, uptimeMs);
}

/* ------------------------------------------------------------------- steps */

export type StepSample = {
  status: string;
  attempts: number;
  claimedAt?: number;
  completedAt?: number;
};

export type RunStatistics = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  /** Arithmetic mean duration of the steps that finished, in milliseconds. */
  meanStepMs: number;
  p95StepMs: number;
  /** Completed steps per hour, measured over the window the run has actually existed. */
  throughputPerHour: number;
  /** Completed / (completed + failed): undefined outcomes are excluded, not counted as wins. */
  successRate: number;
  /** Extra attempts per step. 0 means every step passed first time. */
  retryRate: number;
  progress: number;
};

export function stepDurations(steps: readonly StepSample[]): number[] {
  const durations: number[] = [];
  for (const step of steps) {
    if (step.claimedAt === undefined || step.completedAt === undefined) continue;
    const duration = step.completedAt - step.claimedAt;
    // A clock that ran backwards is not a negative duration; it is no measurement at all.
    if (duration >= 0) durations.push(duration);
  }
  return durations;
}

export function runStatistics(steps: readonly StepSample[], windowMs: number): RunStatistics {
  const completed = steps.filter((step) => step.status === "completed").length;
  const failed = steps.filter((step) => step.status === "failed" || step.status === "blocked").length;
  const running = steps.filter((step) => step.status === "running").length;
  const durations = stepDurations(steps);
  const decided = completed + failed;
  const extraAttempts = steps.reduce((total, step) => total + Math.max(0, step.attempts - 1), 0);
  return {
    total: steps.length,
    completed,
    failed,
    running,
    meanStepMs: mean(durations),
    p95StepMs: quantile(durations, 0.95),
    throughputPerHour: windowMs > 0 ? completed / (windowMs / 3_600_000) : 0,
    successRate: decided > 0 ? completed / decided : 0,
    retryRate: steps.length > 0 ? extraAttempts / steps.length : 0,
    progress: ratio(completed, steps.length),
  };
}

/* ------------------------------------------------------------ presentation */

/** A ratio as a whole-number percentage, so nothing on screen reads "17.34%". */
export function percent(value: number): number {
  return Math.round(clamp01(value) * 100);
}

/**
 * Money at a precision that does not lie. Fractions of a cent are real here — a short run costs
 * less than a cent — so small figures keep four decimals and larger ones drop to two.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Durations as a single dominant unit: a command center is read at a glance, not parsed. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
