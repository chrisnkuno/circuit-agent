import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { defenderFeedPayload, refreshDefenderFeed, type DefenderFeedManifest } from "../packages/agent-core/src/nova-cli/defender-feed";

const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1] || 200);
if (!Number.isSafeInteger(rounds) || rounds < 10 || rounds > 10_000) throw new Error("--rounds must be between 10 and 10000");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-feed-bench-"));
const corpus = await fs.readFile(path.resolve("packages/nova-state/defender-knowledge/knowledge-v1.jsonl"));
const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const now = Date.now();
const unsigned: Omit<DefenderFeedManifest, "signature"> = {
  schemaVersion: 1, feed: "nova-defender", sequence: 1,
  generatedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), keyId: "bench",
  corpus: { url: "https://feed.example/corpus", sha256: createHash("sha256").update(corpus).digest("hex"), bytes: corpus.byteLength, records: corpus.toString("utf8").split("\n").filter(Boolean).length },
};
const manifest = { ...unsigned, signature: sign(null, Buffer.from(defenderFeedPayload(unsigned)), pair.privateKey).toString("base64url") };
const fetcher = async (input: string | URL) => String(input).endsWith("/manifest") ? Response.json(manifest) : new Response(new Uint8Array(corpus));
const samples: number[] = [];
try {
  for (let index = 0; index < rounds; index += 1) {
    const start = performance.now();
    const result = await refreshDefenderFeed({ environment: { NOVA_CONFIG_DIR: directory, NOVA_DEFENDER_FEED_URL: "https://feed.example/manifest" }, keys: { bench: publicKey }, fetch: fetcher, force: true, now });
    if (result.status !== "updated") throw new Error(`benchmark refresh failed: ${result.status}`);
    samples.push(performance.now() - start);
  }
} finally { await fs.rm(directory, { recursive: true, force: true }); }
samples.sort((a, b) => a - b);
const percentile = (value: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * value))];
console.log(JSON.stringify({ rounds, corpusBytes: corpus.byteLength, meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) }, null, 2));
