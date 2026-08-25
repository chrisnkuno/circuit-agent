import { DEFAULT_UPDATE_REGISTRY, FX_ENDPOINTS, hostOf, providerEndpoints, type ProviderEnvironment } from "./endpoints";
import { classifyNetworkError, type NetworkDiagnosis } from "./network";
import type { ColorDepth } from "./banner";
import { modelsEndpoint } from "@circuit-nova/nova-core/providers/model-list";
import type { ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";

/**
 * `nova --doctor`: probes every network endpoint the CLI depends on and reports exactly which
 * one is failing, in seconds.
 *
 * The most common support report is "Nova says there is no internet, but the internet works."
 * Usually the model API is reachable and the FX-rate CDN is not (or vice versa) — the CLI has
 * three separate network dependencies and any of them can be blocked by a corporate proxy, a
 * country-level firewall, or a flaky DNS. A doctor that tests each one separately turns that
 * report into a precise answer: which host failed, what class of failure it was, and whether
 * Nova can actually run.
 */

export type DoctorEndpoint = {
  id: string;
  /** What the endpoint is for, e.g. "model API · CircuitNotion". */
  purpose: string;
  url: string;
  /** False when Nova can run without it (FX rates, update checks, unconfigured providers). */
  required: boolean;
  /** False when the endpoint is skipped because its provider has no credentials. */
  configured: boolean;
  /** Provider probes use the authenticated model-catalog route, not an uninformative base URL. */
  headers?: Record<string, string>;
  provider?: ProviderId;
};

export type DoctorProbe = DoctorEndpoint & {
  ok: boolean;
  /** True when the endpoint was not probed because its provider has no credentials. */
  skipped?: boolean;
  /** Round-trip time in milliseconds when the probe completed. */
  ms?: number;
  status?: number;
  requestId?: string;
  diagnosis?: NetworkDiagnosis;
};

export type DoctorOptions = {
  fetchImpl?: typeof fetch;
  /** Per-endpoint ceiling; probes run concurrently, so this bounds the whole command. */
  timeoutMs?: number;
  /** Injectable monotonic clock for deterministic tests. */
  now?: () => number;
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function modelEndpoints(environment: ProviderEnvironment): DoctorEndpoint[] {
  return providerEndpoints(environment).map((provider) => {
    const catalog = modelsEndpoint(provider.id, environment);
    return {
      id: `provider:${provider.id}`,
      provider: provider.id,
      purpose: `model API · ${provider.label}`,
      url: catalog?.url ?? provider.baseUrl,
      ...(catalog?.headers ? { headers: catalog.headers } : {}),
      // Ollama is always "configured" — it needs no key — but a local daemon most users have never
      // started is not something an unreachable-endpoint failure should be reported for.
      required: provider.configured && provider.id !== "ollama",
      configured: provider.configured,
    };
  });
}

function optionalEndpoints(): DoctorEndpoint[] {
  return [
    ...FX_ENDPOINTS.map((url, index) => ({
      id: `fx:${index}`,
      purpose: "FX rate lookup (optional)",
      // Probe the same concrete document the startup lookup requests. Both hosts intentionally
      // return 404 for the directory itself, which previously made a healthy fallback look broken.
      url: `${url}/usd.json`,
      required: false,
      configured: true,
    })),
    {
      id: "update",
      purpose: "self-update check (optional)",
      url: DEFAULT_UPDATE_REGISTRY,
      required: false,
      configured: true,
    },
  ];
}

export function buildDoctorEndpoints(environment: ProviderEnvironment): DoctorEndpoint[] {
  return [...modelEndpoints(environment), ...optionalEndpoints()];
}

async function probe(endpoint: DoctorEndpoint, options: DoctorOptions): Promise<DoctorProbe> {
  // An unconfigured provider is not a network question — there is nothing to reach until a key
  // is set, and probing anyway would report a "failure" that has no bearing on using Nova.
  if (!endpoint.configured) return { ...endpoint, ok: false, skipped: true };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const started = now();
  try {
    const response = await fetchImpl(endpoint.url, {
      method: "GET",
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    const ms = Math.max(0, Math.round(now() - started));
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("cf-ray") ?? undefined;
    if (response.ok) return { ...endpoint, ok: true, ms, status: response.status, ...(requestId ? { requestId } : {}) };
    const error = Object.assign(new Error(`${response.status} ${response.statusText || "HTTP error"}`), { status: response.status });
    const diagnosis = classifyNetworkError(error, { host: hostOf(endpoint.url), purpose: endpoint.purpose })
      ?? { kind: "aborted" as const, message: error.message };
    return { ...endpoint, ok: false, ms, status: response.status, ...(requestId ? { requestId } : {}), diagnosis };
  } catch (error) {
    const diagnosis = classifyNetworkError(error, { host: hostOf(endpoint.url), purpose: endpoint.purpose })
      ?? { kind: "aborted" as const, message: error instanceof Error ? error.message : String(error) };
    return { ...endpoint, ok: false, ms: Math.max(0, Math.round(now() - started)), diagnosis };
  }
}

/** Runs every probe concurrently; the whole command takes at most one probe timeout. */
export async function runDoctor(environment: ProviderEnvironment, options: DoctorOptions = {}): Promise<DoctorProbe[]> {
  return await Promise.all(buildDoctorEndpoints(environment).map((endpoint) => probe(endpoint, options)));
}

/** 1 when a required endpoint (a configured provider's model API) is unreachable, else 0. */
export function doctorExitCode(probes: readonly DoctorProbe[]): number {
  return probes.some((probe) => probe.required && !probe.ok && !probe.skipped) ? 1 : 0;
}

const RESET = "\u001b[0m";

/** Renders probe results with the colour depth the terminal actually reports. */
export function renderDoctor(probes: readonly DoctorProbe[], depth: ColorDepth): string {
  const paint = (code: string) => (text: string) => (depth === "none" ? text : `${code}${text}${RESET}`);
  const green = paint("\u001b[32m");
  const red = paint("\u001b[31m");
  const yellow = paint("\u001b[33m");
  const dim = paint("\u001b[2m");

  const width = Math.max(...probes.map((probe) => hostOf(probe.url).length));
  const rows: string[] = probes.map((probe) => {
    const host = hostOf(probe.url).padEnd(width);
    const mark = !probe.configured ? "○" : probe.ok ? "✓" : "✗";
    const colour = !probe.configured ? dim : probe.ok ? green : red;
    const detail = !probe.configured
      ? "not configured — set an API key to use this provider"
      : probe.ok
        ? `${probe.ms}ms${probe.status ? ` · HTTP ${probe.status}` : ""}`
        : probe.diagnosis?.kind === "timeout"
          ? `timed out after ${Math.round((probe.ms ?? 0) / 1_000)}s`
          : `${probe.diagnosis?.kind ?? "unreachable"}${probe.status ? ` · HTTP ${probe.status}` : ""}`;
    return `  ${colour(mark)} ${colour(host)}  ${probe.purpose.padEnd(30)} ${detail}`;
  });

  const failures = probes.filter((probe) => probe.required && !probe.ok);
  const optionalFailures = probes.filter((probe) => !probe.required && probe.configured && !probe.ok);
  const configuredRequired = probes.filter((probe) => probe.id.startsWith("provider:") && probe.required);
  const verdict: string[] = [];
  if (failures.length > 0) {
    verdict.push(red(`  Nova cannot reach its model provider: ${failures.map((probe) => hostOf(probe.url)).join(", ")}.`));
    verdict.push(dim("  Fix the connection or the base URL (CIRCUITNOTION_BASE_URL / OPENAI_BASE_URL / ANTHROPIC_BASE_URL), then retry."));
  } else if (configuredRequired.length === 0) {
    verdict.push(yellow("  No provider is configured — set an API key to use Nova."));
  } else {
    verdict.push(green("  All required endpoints are reachable."));
  }
  if (optionalFailures.length > 0) {
    verdict.push(dim(`  Optional: ${optionalFailures.map((probe) => `${hostOf(probe.url)} (${probe.diagnosis?.kind ?? "failed"})`).join(", ")} — Nova still runs; FX costs may fall back to the provider currency.`));
  }

  return ["Nova connectivity check", "", ...rows, "", ...verdict, ""].join("\n");
}

export type DoctorReportContext = {
  cliVersion: string;
  platform: string;
  arch: string;
  runtime: string;
  provider?: string;
  model?: string;
  terminal?: { columns?: number; rows?: number; tty: boolean };
  history?: { mode: string; indexed?: boolean; reason?: string };
};

/**
 * A support artifact safe to paste into an issue.
 *
 * Hosts and request ids are operational identifiers; URLs, headers, environment values, prompts,
 * file paths and response bodies are deliberately absent. Adding fields here should stay an
 * allowlist — serializing the environment and trying to redact it afterwards is how secrets leak.
 */
export function doctorReport(probes: readonly DoctorProbe[], context: DoctorReportContext): Record<string, unknown> {
  return {
    schema: "nova-doctor-report/v1",
    generatedAt: new Date().toISOString(),
    cli: {
      version: context.cliVersion,
      platform: context.platform,
      arch: context.arch,
      runtime: context.runtime,
      ...(context.provider ? { provider: context.provider } : {}),
      ...(context.model ? { model: context.model } : {}),
    },
    ...(context.terminal ? { terminal: context.terminal } : {}),
    ...(context.history ? { history: context.history } : {}),
    endpoints: probes.map((probe) => ({
      id: probe.id,
      purpose: probe.purpose,
      host: hostOf(probe.url),
      configured: probe.configured,
      required: probe.required,
      ok: probe.ok,
      ...(probe.skipped ? { skipped: true } : {}),
      ...(probe.ms !== undefined ? { ms: probe.ms } : {}),
      ...(probe.status !== undefined ? { status: probe.status } : {}),
      ...(probe.requestId ? { requestId: probe.requestId } : {}),
      ...(probe.diagnosis ? { diagnosis: { kind: probe.diagnosis.kind, message: probe.diagnosis.message, ...(probe.diagnosis.hint ? { hint: probe.diagnosis.hint } : {}) } } : {}),
    })),
  };
}
