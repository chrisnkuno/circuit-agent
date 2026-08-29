/** Server-only authority for the centralized Defensive Brain distribution feed. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defenderFeedPayload, type DefenderFeedManifest } from "@circuit-nova/nova-core/nova-cli/defender-feed";

const CORPUS_RELATIVE = path.join("packages", "nova-state", "defender-knowledge", "knowledge-v1.jsonl");

/**
 * Finds the corpus without assuming where the process was started.
 *
 * This was `path.join(process.cwd(), ...)`, which quietly made the feed a function of the launch
 * directory: it resolved from the repo root and broke from `apps/web` — which is exactly where the
 * Next server runs. The failure surfaced as a bare ENOENT, so it read as a missing file rather
 * than a wrong assumption, and it hid a real assertion in the test suite behind it.
 *
 * Walking up from the working directory covers every layout the app is actually started in — repo
 * root, `apps/web`, or a nested worktree — and the error names the path it wanted when it runs out
 * of parents, rather than leaving a bare ENOENT to be interpreted.
 */
export async function resolveCorpus(from: string = process.cwd()): Promise<string> {
  const tried: string[] = [];
  let directory = from;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, CORPUS_RELATIVE);
    tried.push(candidate);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`Defender corpus not found. Looked for ${CORPUS_RELATIVE} in:\n${tried.join("\n")}`);
}

export async function defenderCorpus(): Promise<{ bytes: Buffer; digest: string; records: number }> {
  const bytes = await fs.readFile(await resolveCorpus());
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    records: bytes.toString("utf8").split("\n").filter((line) => line.trim()).length,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value.replace(/\\n/g, "\n");
}

/** Build a short-lived manifest. The corpus stays reviewed in git; the private key stays in ops. */
export async function signedDefenderManifest(origin: string, now = Date.now()): Promise<DefenderFeedManifest> {
  const corpus = await defenderCorpus();
  const sequence = Number(required("DEFENDER_BRAIN_SEQUENCE"));
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("DEFENDER_BRAIN_SEQUENCE must be a positive integer");
  const generated = new Date(Math.floor(now / 86_400_000) * 86_400_000);
  const unsigned: Omit<DefenderFeedManifest, "signature"> = {
    schemaVersion: 1,
    feed: "nova-defender",
    sequence,
    generatedAt: generated.toISOString(),
    expiresAt: new Date(generated.getTime() + 8 * 86_400_000).toISOString(),
    keyId: required("DEFENDER_BRAIN_KEY_ID"),
    corpus: {
      url: `${origin}/api/defender-brain/corpus`,
      sha256: corpus.digest,
      bytes: corpus.bytes.byteLength,
      records: corpus.records,
    },
  };
  const key = createPrivateKey(required("DEFENDER_BRAIN_SIGNING_KEY"));
  return { ...unsigned, signature: sign(null, Buffer.from(defenderFeedPayload(unsigned)), key).toString("base64url") };
}
