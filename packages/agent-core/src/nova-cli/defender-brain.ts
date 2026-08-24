/**
 * Native, bounded retrieval over Nova's reviewed defensive-security corpus.
 * The reviewed JSONL is authoritative; SQLite is only a disposable, token-saving read model.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryConnectNovaState, type DefenderBrainHit, type NovaStateClient } from "./state-client";
import { activeDefenderCorpusDirectory } from "./defender-feed";

type BrainClient = Pick<NovaStateClient, "rebuildDefenderBrain" | "searchDefenderBrain" | "close">;

async function existingDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next installed/source layout */ }
  }
  return null;
}

/** Finds the reviewed corpus in a bundled CLI or this monorepo without consulting cwd. */
export function defenderKnowledgeCandidates(moduleUrl = import.meta.url): string[] {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.join(directory, "defender-knowledge"),
    path.resolve(directory, "../../../nova-state/defender-knowledge"),
  ];
}

/**
 * Lazy native retrieval for Defender mode. Failure is a visible capability downgrade; existing
 * curated playbooks remain available, so a missing platform package never prevents a review.
 */
export class DefenderBrain {
  private client: BrainClient | null = null;
  private initialized: Promise<boolean> | null = null;
  private sourceRoot: string | null = null;
  private disabledReason: string | null = null;

  constructor(
    private readonly dataRoot: string,
    private readonly connect: () => Promise<BrainClient | null> = () => tryConnectNovaState(),
    private readonly candidates = defenderKnowledgeCandidates(),
    private readonly activeCorpus: () => Promise<string | undefined> = () => activeDefenderCorpusDirectory(process.env),
  ) {}

  private ensureReady(): Promise<boolean> {
    this.initialized ??= (async () => {
      try {
        const replica = await this.activeCorpus();
        const sources = [replica, ...this.candidates].filter((value): value is string => Boolean(value));
        this.client = await this.connect();
        if (!this.client) throw new Error("native Nova State package is unavailable on this platform");
        let lastError: unknown;
        for (const source of sources) {
          try {
            const available = await existingDirectory([source]);
            if (!available) continue;
            const report = await this.client.rebuildDefenderBrain(available, this.dataRoot);
            if (report.records === 0) throw new Error("defensive knowledge corpus contains no accepted records");
            this.sourceRoot = available;
            return true;
          } catch (error) { lastError = error; }
        }
        throw lastError ?? new Error("reviewed defensive knowledge corpus is not installed");
      } catch (error) {
        this.disabledReason = error instanceof Error ? error.message : String(error);
        await this.client?.close().catch(() => undefined);
        this.client = null;
        return false;
      }
    })();
    return this.initialized;
  }

  async search(query: string, limit = 4): Promise<{ hits: DefenderBrainHit[]; reason?: string }> {
    if (!(await this.ensureReady())) return { hits: [], reason: this.disabledReason ?? "defensive brain unavailable" };
    try {
      return { hits: await this.client!.searchDefenderBrain(this.sourceRoot!, this.dataRoot, query, Math.min(8, Math.max(1, limit))) };
    } catch (error) {
      this.disabledReason = error instanceof Error ? error.message : String(error);
      return { hits: [], reason: this.disabledReason };
    }
  }

  async close(): Promise<void> { await this.client?.close().catch(() => undefined); this.client = null; }
}
