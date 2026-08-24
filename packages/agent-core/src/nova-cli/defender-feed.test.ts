import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeDefenderCorpusDirectory,
  defenderFeedPayload,
  DEFENDER_FEED_FILENAME,
  DEFENDER_FEED_INTERVAL_MS,
  readDefenderFeedState,
  refreshDefenderFeed,
  type DefenderFeedManifest,
} from "./defender-feed";

describe("central Defender feed replication", () => {
  let directory: string;
  let environment: Record<string, string | undefined>;
  const keys = generateKeyPairSync("ed25519");
  const keyId = "test-2026";
  const publicKeys = { [keyId]: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const corpus = Buffer.from(`${JSON.stringify({ schemaVersion: 1, id: "one" })}\n`);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-defender-feed-"));
    environment = { NOVA_CONFIG_DIR: directory, NOVA_DEFENDER_FEED_URL: "https://feed.example/manifest" };
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function manifest(overrides: Partial<DefenderFeedManifest> = {}): DefenderFeedManifest {
    const unsigned: Omit<DefenderFeedManifest, "signature"> = {
      schemaVersion: 1,
      feed: "nova-defender",
      sequence: 7,
      generatedAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      keyId,
      corpus: {
        url: "https://feed.example/corpus",
        sha256: createHash("sha256").update(corpus).digest("hex"),
        bytes: corpus.byteLength,
        records: 1,
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== "signature")),
    } as Omit<DefenderFeedManifest, "signature">;
    return { ...unsigned, signature: sign(null, Buffer.from(defenderFeedPayload(unsigned)), keys.privateKey).toString("base64url"), ...(overrides.signature ? { signature: overrides.signature } : {}) };
  }

  function responses(value: DefenderFeedManifest, body = corpus) {
    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/manifest")) {
        if ((init?.headers as Record<string, string> | undefined)?.["if-none-match"] === '"v7"') return new Response(null, { status: 304 });
        return Response.json(value, { headers: { etag: '"v7"' } });
      }
      return new Response(body);
    };
  }

  it("verifies, content-addresses and activates a signed replica", async () => {
    const result = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: responses(manifest()), now: Date.parse("2026-08-24T12:00:00Z") });
    expect(result).toMatchObject({ status: "updated", sequence: 7, records: 1 });
    const active = await activeDefenderCorpusDirectory(environment);
    expect(active).toBe(result.activeDirectory);
    expect(await fs.readFile(path.join(active!, DEFENDER_FEED_FILENAME))).toEqual(corpus);
    expect(await readDefenderFeedState(environment)).toMatchObject({ sequence: 7, etag: '"v7"' });
  });

  it("uses the persisted interval and ETag without downloading the corpus again", async () => {
    const value = manifest();
    await refreshDefenderFeed({ environment, keys: publicKeys, fetch: responses(value), now: Date.parse("2026-08-24T12:00:00Z") });
    let requests = 0;
    const notDue = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: async () => { requests += 1; throw new Error("should not fetch"); }, now: Date.parse("2026-08-24T12:00:00Z") + DEFENDER_FEED_INTERVAL_MS - 1 });
    expect(notDue.status).toBe("not_due");
    expect(requests).toBe(0);
    const unchanged = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: responses(value), now: Date.parse("2026-08-24T12:00:00Z") + DEFENDER_FEED_INTERVAL_MS, force: true });
    expect(unchanged.status).toBe("not_modified");
  });

  it.each([
    ["bad signature", () => manifest({ signature: "not-a-signature" }), corpus, "signature"],
    ["tampered bytes", () => manifest(), Buffer.from("tampered\n"), "byte count"],
    ["cross-origin corpus", () => manifest({ corpus: { ...manifest().corpus, url: "https://attacker.example/corpus" } }), corpus, "origin"],
    ["expired manifest", () => manifest({ expiresAt: "2026-08-23T00:00:00.000Z" }), corpus, "expired"],
    ["oversized response", () => manifest(), Buffer.concat([corpus, Buffer.alloc(1)]), "client limit"],
  ])("rejects %s without activating it", async (_name, make, body, reason) => {
    const result = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: responses(make(), body), now: Date.parse("2026-08-24T12:00:00Z") });
    expect(result).toMatchObject({ status: "rejected" });
    expect((result as { reason: string }).reason).toContain(reason);
    expect(await activeDefenderCorpusDirectory(environment)).toBeUndefined();
  });

  it("refuses rollback and preserves the last verified replica when the feed fails", async () => {
    const now = Date.parse("2026-08-24T12:00:00Z");
    const first = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: responses(manifest()), now });
    const previousDirectory = first.status === "updated" ? first.activeDirectory : "";
    const rollback = manifest({ sequence: 6 });
    const result = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: async (input) => String(input).endsWith("/manifest") ? Response.json(rollback) : new Response(corpus), now: now + DEFENDER_FEED_INTERVAL_MS, force: true });
    expect(result).toMatchObject({ status: "rejected", activeDirectory: previousDirectory });
    expect((result as { reason: string }).reason).toContain("rollback");
    expect(await activeDefenderCorpusDirectory(environment)).toBe(previousDirectory);
  });

  it("treats an offline central service as a capability-neutral event", async () => {
    const result = await refreshDefenderFeed({ environment, keys: publicKeys, fetch: async () => { throw new Error("offline"); }, now: Date.parse("2026-08-24T12:00:00Z") });
    expect(result).toMatchObject({ status: "unavailable", reason: "offline" });
  });
});
