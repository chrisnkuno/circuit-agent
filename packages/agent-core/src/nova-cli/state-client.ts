import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** The native state protocol evolves independently from the agent/runtime protocol. */
export const NOVA_STATE_PROTOCOL_VERSION = 1 as const;

export type StateEvidenceSource = "snapshot" | "journal";
export type StateContextDocument = { id: number; source: StateEvidenceSource; sourcePosition: number; role: string | null; kind: string; text: string; anchor: boolean };
export type StateSearchHit = {
  sessionId: string; title: string; score: number; source: StateEvidenceSource; sourcePosition: number;
  role: string | null; kind: string; snippet: string; context: StateContextDocument[];
  bookendStart: StateContextDocument[]; bookendEnd: StateContextDocument[]; why: string[];
};
export type StateSessionSummary = {
  sessionId: string; title: string; createdAt: number | null; updatedAt: number | null; revision: number;
  eventCount: number; lastSequence: number; hasSnapshot: boolean; hasJournal: boolean;
};
export type StateIndexReport = {
  sessions: number; events: number; documents: number;
  failures: Array<{ source: StateEvidenceSource; sessionId?: string; message: string }>;
};
export type DefenderBrainReport = { records: number; rejected: number; sourceFiles: number; changed: boolean };
export type DefenderBrainHit = {
  id: string; domain: string; title: string; summary: string; guidance: string; tags: string[];
  sources: Array<{ title: string; url: string; publishedAt: string | null; accessedAt: string; primary: boolean }>;
  reviewedAt: string; expiresAt: string; confidence: "high" | "medium" | "low"; stale: boolean; score: number;
};

type StateResponse = { id: string | number | null; protocolVersion: number; ok: boolean; result?: unknown; error?: { code: string; message: string } };
type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class NovaStateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NovaStateError"; }
}

function isStateResponse(value: unknown): value is StateResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<StateResponse>;
  return (typeof response.id === "string" || typeof response.id === "number" || response.id === null)
    && typeof response.protocolVersion === "number"
    && typeof response.ok === "boolean";
}

const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@circuit-nova/state-darwin-arm64",
  "darwin-x64": "@circuit-nova/state-darwin-x64",
  "win32-arm64": "@circuit-nova/state-win32-arm64",
  "win32-x64": "@circuit-nova/state-win32-x64",
  "linux-arm64-gnu": "@circuit-nova/state-linux-arm64-gnu",
  "linux-arm64-musl": "@circuit-nova/state-linux-arm64-musl",
  "linux-x64-gnu": "@circuit-nova/state-linux-x64-gnu",
  "linux-x64-musl": "@circuit-nova/state-linux-x64-musl",
};

function linuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
}

export function statePlatformKey(platform = process.platform, architecture = process.arch): string {
  return platform === "linux" ? `${platform}-${architecture}-${linuxLibc()}` : `${platform}-${architecture}`;
}

async function executable(pathname: string): Promise<boolean> {
  try { await access(pathname, process.platform === "win32" ? 0 : 1); return true; } catch { return false; }
}

/** Resolves an override, an installed native package, or this checkout's Cargo output—never a download. */
export async function resolveNovaStateBinary(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (environment.NOVA_STATE_BINARY) {
    const explicit = path.resolve(environment.NOVA_STATE_BINARY);
    if (!(await executable(explicit))) throw new Error(`NOVA_STATE_BINARY is not executable: ${explicit}`);
    return explicit;
  }

  const packageName = PLATFORM_PACKAGES[statePlatformKey()];
  if (packageName) {
    try {
      const require = createRequire(import.meta.url);
      const manifest = require.resolve(`${packageName}/package.json`);
      const candidate = path.join(path.dirname(manifest), "bin", process.platform === "win32" ? "nova-state.exe" : "nova-state");
      if (await executable(candidate)) return candidate;
    } catch {
      // Optional dependencies for other targets are absent by design.
    }
  }

  const filename = process.platform === "win32" ? "nova-state.exe" : "nova-state";
  for (const profile of ["release", "debug"]) {
    const candidate = path.resolve(process.cwd(), "packages", "nova-state", "target", profile, filename);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

export type StateProcess = EventEmitter & {
  stdin: Writable; stdout: Readable; stderr: Readable;
  exitCode: number | null; signalCode: NodeJS.Signals | null; killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};
export type NovaStateClientOptions = {
  binary: string; args?: string[]; requestTimeoutMs?: number; environment?: NodeJS.ProcessEnv;
  /** Test/embedding seam; ordinary callers always use shell-free node:child_process.spawn. */
  processFactory?: (binary: string, args: string[], options: SpawnOptionsWithoutStdio) => StateProcess;
};

/** One long-lived, shell-free JSONL connection to the native read model. */
export class NovaStateClient {
  private readonly child: StateProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private nextId = 0;
  private closed = false;
  private stderr = "";

  private constructor(options: NovaStateClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    const processFactory = options.processFactory ?? ((binary, args, spawnOptions) => spawn(binary, args, spawnOptions) as StateProcess);
    this.child = processFactory(options.binary, options.args ?? [], {
      env: options.environment ?? process.env,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.failAll(new Error(`nova-state exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
    });
  }

  static async connect(options: NovaStateClientOptions): Promise<NovaStateClient> {
    const client = new NovaStateClient(options);
    try {
      await client.call("ping", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private receive(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { this.failAll(new Error("nova-state emitted malformed JSON")); return; }
    if (!isStateResponse(parsed)) { this.failAll(new Error("nova-state emitted a malformed protocol response")); return; }
    const response = parsed;
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (response.protocolVersion !== NOVA_STATE_PROTOCOL_VERSION) {
      pending.reject(new NovaStateError("unsupported_protocol", `Expected nova-state protocol ${NOVA_STATE_PROTOCOL_VERSION}, received ${response.protocolVersion}`));
    } else if (!response.ok) {
      pending.reject(new NovaStateError(response.error?.code ?? "state_error", response.error?.message ?? "nova-state request failed"));
    } else pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    const shouldTerminate = !this.closed;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (shouldTerminate && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) {
      try { this.child.kill(); } catch { /* The process may already be exiting. */ }
    }
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("nova-state client is closed"));
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NovaStateError("timeout", `nova-state ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, protocolVersion: NOVA_STATE_PROTOCOL_VERSION, method, params })}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id); clearTimeout(request.timer); request.reject(error);
      });
    });
  }

  rebuild(root: string): Promise<StateIndexReport> { return this.call("index.rebuild", { root }); }
  search(root: string, query: string, options: { sessionId?: string; limit?: number; roleFilter?: string[]; sort?: "relevance" | "newest" | "oldest"; window?: number } = {}): Promise<StateSearchHit[]> {
    return this.call("search", { root, query, ...options });
  }
  sessions(root: string, limit = 20): Promise<StateSessionSummary[]> { return this.call("session.list", { root, limit }); }
  context(root: string, sessionId: string, source: StateEvidenceSource, position: number, window = 5): Promise<StateContextDocument[]> {
    return this.call("session.context", { root, sessionId, source, position, window });
  }
  rebuildDefenderBrain(sourceRoot: string, dataRoot: string): Promise<DefenderBrainReport> {
    return this.call("brain.rebuild", { sourceRoot, dataRoot });
  }
  searchDefenderBrain(sourceRoot: string, dataRoot: string, query: string, limit = 4, now = new Date().toISOString().slice(0, 10)): Promise<DefenderBrainHit[]> {
    return this.call("brain.search", { sourceRoot, dataRoot, query, limit, now });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      setTimeout(() => { this.child.kill(); resolve(); }, 1_000).unref();
    });
    this.failAll(new Error("nova-state client closed"));
  }
}

/** Missing native support is a visible capability downgrade, never a CLI startup failure. */
export async function tryConnectNovaState(options: Omit<NovaStateClientOptions, "binary"> = {}): Promise<NovaStateClient | null> {
  // Bun's node:child_process compatibility currently accepts the write callback but does not
  // deliver this Rust sidecar's stdout/stderr pipe data. Waiting for the ordinary 10s protocol
  // timeout turns every model-free history command into a 10s operation (and `history status`
  // into 20s after list + status). The canonical JSON history remains fully functional, so take
  // the explicit portable fallback immediately when Nova itself is launched under Bun. Published
  // CLI entrypoints use Node and retain native SQLite + FTS5.
  if ((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun) return null;
  const binary = await resolveNovaStateBinary(options.environment);
  return binary ? NovaStateClient.connect({ ...options, binary }) : null;
}
