import {
  tryConnectNovaState,
  type NovaStateClient,
  type StateIndexReport,
  type StateSearchHit,
  type StateSessionSummary,
} from "@circuit-nova/nova-core/nova-cli/state-client";

type StateReader = Pick<NovaStateClient, "rebuild" | "search" | "sessions" | "close">;
type StateEnvironment = Record<string, string | undefined>;
type ConnectState = (environment: StateEnvironment) => Promise<StateReader | null>;

export type CliStateStatus = {
  mode: "native" | "fallback";
  indexed: boolean;
  report?: StateIndexReport;
  reason?: string;
};

/**
 * The CLI-facing lifecycle for nova-state.
 *
 * Canonical session JSON and event journals remain the fallback and source of truth. This class
 * owns only the optional read model: one lazy child process, one coalesced rebuild at a time, and a
 * permanent fallback after a protocol/process failure so history never takes the CLI down with it.
 */
export class CliStateHistory {
  private client: StateReader | null = null;
  private connectAttempted = false;
  private disabledReason: string | undefined;
  private generation = 1;
  private indexedGeneration = 0;
  private refreshPromise: Promise<StateIndexReport | null> | null = null;
  private lastReport: StateIndexReport | undefined;

  constructor(
    private readonly root: string,
    private readonly environment: StateEnvironment = process.env,
    private readonly connectState: ConnectState = async (environment) => tryConnectNovaState({ environment: environment as NodeJS.ProcessEnv }),
  ) {}

  /** A saved turn changed canonical state; the next read must observe it. */
  markDirty(): void {
    this.generation += 1;
  }

  private async ensureClient(): Promise<StateReader | null> {
    if (this.connectAttempted) return this.client;
    this.connectAttempted = true;
    try {
      this.client = await this.connectState(this.environment);
      if (!this.client) this.disabledReason = "native state package is not installed for this platform";
    } catch (error) {
      this.disabledReason = error instanceof Error ? error.message : String(error);
      this.client = null;
    }
    return this.client;
  }

  private async disable(error: unknown): Promise<null> {
    this.disabledReason = error instanceof Error ? error.message : String(error);
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
    return null;
  }

  /** Replays canonical state once per observed generation; concurrent callers share the work. */
  async refresh(): Promise<StateIndexReport | null> {
    if (this.indexedGeneration === this.generation && this.lastReport) return this.lastReport;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const client = await this.ensureClient();
      if (!client) return null;
      for (;;) {
        const generation = this.generation;
        try {
          const report = await client.rebuild(this.root);
          this.lastReport = report;
          this.indexedGeneration = generation;
          // A turn may finish while replay is running. Loop once more so the background refresh
          // catches that save instead of merely declaring the projection dirty for a later read.
          if (this.generation === generation) return report;
        } catch (error) {
          return this.disable(error);
        }
      }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async sessions(limit = 30): Promise<StateSessionSummary[] | null> {
    if (!(await this.refresh())) return null;
    try {
      return await this.client!.sessions(this.root, limit);
    } catch (error) {
      return this.disable(error);
    }
  }

  async search(query: string, limit = 20): Promise<StateSearchHit[] | null> {
    if (!(await this.refresh())) return null;
    try {
      return await this.client!.search(this.root, query, { limit, window: 3 });
    } catch (error) {
      return this.disable(error);
    }
  }

  async status(): Promise<CliStateStatus> {
    const client = await this.ensureClient();
    if (!client) return { mode: "fallback", indexed: false, reason: this.disabledReason };
    return {
      mode: "native",
      indexed: this.indexedGeneration === this.generation,
      ...(this.lastReport ? { report: this.lastReport } : {}),
    };
  }

  async close(): Promise<void> {
    await this.refreshPromise?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }
}
