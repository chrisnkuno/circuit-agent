/**
 * Trusted replication for Nova's centrally published Defensive Brain.
 *
 * The network is only a distribution channel. A feed becomes authoritative locally only after its
 * manifest signature, sequence, expiry, byte count and content digest all validate. Replicas are
 * content-addressed and activated by an atomic state-file rename, so interruption cannot replace a
 * working brain with a partial download.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { novaConfigDirectory } from "./memory";

export const DEFENDER_FEED_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DEFENDER_FEED_MAX_BYTES = 8 * 1024 * 1024;
export const DEFENDER_FEED_MAX_MANIFEST_BYTES = 64 * 1024;
export const DEFENDER_FEED_FILENAME = "knowledge-v1.jsonl";

export type DefenderFeedManifest = {
  schemaVersion: 1;
  feed: "nova-defender";
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  corpus: { url: string; sha256: string; bytes: number; records: number };
  signature: string;
};

export type DefenderFeedState = {
  schemaVersion: 1;
  lastCheckedAt: number;
  sequence?: number;
  activeDigest?: string;
  etag?: string;
};

export type DefenderFeedResult =
  | { status: "not_due" | "not_configured" | "not_modified"; activeDirectory?: string }
  | { status: "updated"; activeDirectory: string; sequence: number; records: number }
  | { status: "unavailable" | "rejected"; reason: string; activeDirectory?: string };

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function feedRoot(environment: Record<string, string | undefined>): string {
  return path.join(novaConfigDirectory(environment), "defender-brain");
}

function statePath(environment: Record<string, string | undefined>): string {
  return path.join(feedRoot(environment), "feed-state.json");
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function readDefenderFeedState(environment: Record<string, string | undefined>): Promise<DefenderFeedState | null> {
  try {
    const value = JSON.parse(await fs.readFile(statePath(environment), "utf8")) as Partial<DefenderFeedState>;
    if (value.schemaVersion !== 1 || !Number.isFinite(value.lastCheckedAt)) return null;
    return {
      schemaVersion: 1,
      lastCheckedAt: value.lastCheckedAt!,
      ...(Number.isSafeInteger(value.sequence) && value.sequence! >= 0 ? { sequence: value.sequence } : {}),
      ...(validDigest(value.activeDigest) ? { activeDigest: value.activeDigest } : {}),
      ...(typeof value.etag === "string" && value.etag.length <= 512 ? { etag: value.etag } : {}),
    };
  } catch { return null; }
}

export function defenderFeedPayload(manifest: Omit<DefenderFeedManifest, "signature">): string {
  // Explicit property order is part of the wire contract. Do not sign arbitrary parsed JSON.
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    feed: manifest.feed,
    sequence: manifest.sequence,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    keyId: manifest.keyId,
    corpus: {
      url: manifest.corpus.url,
      sha256: manifest.corpus.sha256,
      bytes: manifest.corpus.bytes,
      records: manifest.corpus.records,
    },
  });
}

function parseManifest(value: unknown, now: number): DefenderFeedManifest {
  if (!value || typeof value !== "object") throw new Error("manifest is not an object");
  const manifest = value as Partial<DefenderFeedManifest>;
  const corpus = manifest.corpus;
  const generated = Date.parse(manifest.generatedAt ?? "");
  const expires = Date.parse(manifest.expiresAt ?? "");
  if (manifest.schemaVersion !== 1 || manifest.feed !== "nova-defender") throw new Error("unsupported manifest schema");
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence! < 1) throw new Error("invalid feed sequence");
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= now || generated > now + 300_000 || expires <= generated) throw new Error("manifest is expired or has invalid dates");
  if (typeof manifest.keyId !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(manifest.keyId)) throw new Error("invalid signing key id");
  if (!corpus || typeof corpus.url !== "string" || !validDigest(corpus.sha256)) throw new Error("invalid corpus descriptor");
  if (!Number.isSafeInteger(corpus.bytes) || corpus.bytes < 1 || corpus.bytes > DEFENDER_FEED_MAX_BYTES) throw new Error("corpus size exceeds the client limit");
  if (!Number.isSafeInteger(corpus.records) || corpus.records < 1) throw new Error("invalid corpus record count");
  if (typeof manifest.signature !== "string" || manifest.signature.length > 512) throw new Error("invalid manifest signature");
  return manifest as DefenderFeedManifest;
}

function secureCorpusUrl(manifestUrl: URL, corpusUrl: string): URL {
  const resolved = new URL(corpusUrl, manifestUrl);
  const loopback = resolved.hostname === "localhost" || resolved.hostname === "127.0.0.1" || resolved.hostname === "::1";
  if (resolved.protocol !== "https:" && !(loopback && resolved.protocol === "http:")) throw new Error("corpus URL must use HTTPS");
  if (resolved.origin !== manifestUrl.origin) throw new Error("corpus URL must share the manifest origin");
  return resolved;
}

function publicKeyFor(keyId: string, keys: Readonly<Record<string, string>>): ReturnType<typeof createPublicKey> {
  const encoded = keys[keyId]?.trim();
  if (!encoded) throw new Error(`untrusted signing key '${keyId}'`);
  try {
    return encoded.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(encoded.replace(/\\n/g, "\n"))
      : createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
  } catch { throw new Error(`invalid public key '${keyId}'`); }
}

async function boundedResponseBody(response: Response, maximum: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds the client limit`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error(`${label} exceeds the client limit`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function activeDirectory(environment: Record<string, string | undefined>, state?: DefenderFeedState | null): Promise<string | undefined> {
  const current = state ?? await readDefenderFeedState(environment);
  if (!current?.activeDigest) return undefined;
  const directory = path.join(feedRoot(environment), "replicas", current.activeDigest);
  try { await fs.access(path.join(directory, DEFENDER_FEED_FILENAME)); return directory; } catch { return undefined; }
}

/** Resolve the active verified replica. Callers should append their bundled corpus as fallback. */
export async function activeDefenderCorpusDirectory(environment: Record<string, string | undefined>): Promise<string | undefined> {
  return activeDirectory(environment);
}

/**
 * Poll one central feed. This function is deliberately quiet and side-effect bounded: callers fire
 * it in the background, and an offline or compromised feed leaves the last verified replica intact.
 */
export async function refreshDefenderFeed(options: {
  environment: Record<string, string | undefined>;
  keys: Readonly<Record<string, string>>;
  fetch?: Fetch;
  now?: number;
  force?: boolean;
}): Promise<DefenderFeedResult> {
  const endpoint = options.environment.NOVA_DEFENDER_FEED_URL?.trim();
  const current = await readDefenderFeedState(options.environment);
  const active = await activeDirectory(options.environment, current);
  if (!endpoint) return { status: "not_configured", ...(active ? { activeDirectory: active } : {}) };
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(endpoint);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(manifestUrl.hostname);
    if (manifestUrl.protocol !== "https:" && !(loopback && manifestUrl.protocol === "http:")) throw new Error("feed URL must use HTTPS");
  } catch (error) { return { status: "rejected", reason: error instanceof Error ? error.message : String(error), ...(active ? { activeDirectory: active } : {}) }; }

  const now = options.now ?? Date.now();
  if (!options.force && current && now >= current.lastCheckedAt && now - current.lastCheckedAt < DEFENDER_FEED_INTERVAL_MS) return { status: "not_due", ...(active ? { activeDirectory: active } : {}) };
  const fetcher = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(manifestUrl, { headers: current?.etag ? { "if-none-match": current.etag } : undefined, signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    await atomicJson(statePath(options.environment), { ...current, schemaVersion: 1, lastCheckedAt: now });
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error), ...(active ? { activeDirectory: active } : {}) };
  }
  if (response.status === 304) {
    await atomicJson(statePath(options.environment), { ...current, schemaVersion: 1, lastCheckedAt: now });
    return { status: "not_modified", ...(active ? { activeDirectory: active } : {}) };
  }
  if (!response.ok) {
    await atomicJson(statePath(options.environment), { ...current, schemaVersion: 1, lastCheckedAt: now });
    return { status: "unavailable", reason: `feed returned HTTP ${response.status}`, ...(active ? { activeDirectory: active } : {}) };
  }

  try {
    const manifest = parseManifest(JSON.parse((await boundedResponseBody(response, DEFENDER_FEED_MAX_MANIFEST_BYTES, "manifest")).toString("utf8")), now);
    if (current?.sequence && manifest.sequence < current.sequence) throw new Error("feed sequence rollback refused");
    if (current?.sequence === manifest.sequence && current.activeDigest && current.activeDigest !== manifest.corpus.sha256) throw new Error("feed sequence was reused for different content");
    const unsigned = { ...manifest } as Partial<DefenderFeedManifest>;
    delete unsigned.signature;
    const valid = verifySignature(null, Buffer.from(defenderFeedPayload(unsigned as Omit<DefenderFeedManifest, "signature">)), publicKeyFor(manifest.keyId, options.keys), Buffer.from(manifest.signature, "base64url"));
    if (!valid) throw new Error("manifest signature verification failed");
    const corpusUrl = secureCorpusUrl(manifestUrl, manifest.corpus.url);
    const corpusResponse = await fetcher(corpusUrl, { signal: AbortSignal.timeout(8_000) });
    if (!corpusResponse.ok) throw new Error(`corpus returned HTTP ${corpusResponse.status}`);
    const bytes = await boundedResponseBody(corpusResponse, manifest.corpus.bytes, "corpus");
    if (bytes.byteLength !== manifest.corpus.bytes) throw new Error("corpus byte count does not match manifest");
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.corpus.sha256) throw new Error("corpus digest does not match manifest");
    const records = bytes.toString("utf8").split("\n").filter((line) => line.trim()).length;
    if (records !== manifest.corpus.records) throw new Error("corpus record count does not match manifest");

    const replica = path.join(feedRoot(options.environment), "replicas", manifest.corpus.sha256);
    await fs.mkdir(replica, { recursive: true });
    const corpusFile = path.join(replica, DEFENDER_FEED_FILENAME);
    try {
      await fs.access(corpusFile);
    } catch {
      const temporary = `${corpusFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      try { await fs.rename(temporary, corpusFile); }
      catch (error) {
        await fs.rm(temporary, { force: true });
        // Another Nova process may have won the same content-addressed activation race.
        try { await fs.access(corpusFile); } catch { throw error; }
      }
    }
    const next: DefenderFeedState = { schemaVersion: 1, lastCheckedAt: now, sequence: manifest.sequence, activeDigest: manifest.corpus.sha256, ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}) };
    await atomicJson(statePath(options.environment), next);
    return { status: "updated", activeDirectory: replica, sequence: manifest.sequence, records };
  } catch (error) {
    await atomicJson(statePath(options.environment), { ...current, schemaVersion: 1, lastCheckedAt: now });
    return { status: "rejected", reason: error instanceof Error ? error.message : String(error), ...(active ? { activeDirectory: active } : {}) };
  }
}
