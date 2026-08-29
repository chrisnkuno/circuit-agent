import { generateKeyPairSync, verify } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defenderFeedPayload } from "@circuit-nova/nova-core/nova-cli/defender-feed";
import { defenderCorpus, resolveCorpus, signedDefenderManifest } from "./defender-feed-server";

const saved = {
  sequence: process.env.DEFENDER_BRAIN_SEQUENCE,
  id: process.env.DEFENDER_BRAIN_KEY_ID,
  key: process.env.DEFENDER_BRAIN_SIGNING_KEY,
};

afterEach(() => {
  set("DEFENDER_BRAIN_SEQUENCE", saved.sequence);
  set("DEFENDER_BRAIN_KEY_ID", saved.id);
  set("DEFENDER_BRAIN_SIGNING_KEY", saved.key);
});

describe("central Defender feed authority", () => {
  it("describes and signs the reviewed repository corpus", async () => {
    const pair = generateKeyPairSync("ed25519");
    process.env.DEFENDER_BRAIN_SEQUENCE = "12";
    process.env.DEFENDER_BRAIN_KEY_ID = "release-12";
    process.env.DEFENDER_BRAIN_SIGNING_KEY = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const manifest = await signedDefenderManifest("https://feed.example", Date.parse("2026-08-24T13:00:00Z"));
    const corpus = await defenderCorpus();
    const { signature, ...unsigned } = manifest;
    expect(manifest).toMatchObject({ sequence: 12, keyId: "release-12", corpus: { bytes: corpus.bytes.byteLength, records: corpus.records } });
    expect(verify(null, Buffer.from(defenderFeedPayload(unsigned)), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  // The corpus path was `process.cwd()`-relative, so the feed worked from the repo root and threw
  // a bare ENOENT from `apps/web` — where the Next server actually runs. Reading it from more than
  // one working directory is the property that was missing, so it is the property under test.
  it("reads the corpus regardless of the directory the process was started in", async () => {
    // Resolved from an explicit directory rather than by chdir: process.cwd() is global state
    // shared with every other test in the worker, so mutating it to make an assertion is a way to
    // fail unrelated files.
    const root = path.resolve(__dirname, "..", "..", "..");
    const fromRoot = await resolveCorpus(root);
    const fromWebApp = await resolveCorpus(path.join(root, "apps", "web"));
    expect(fromWebApp).toBe(fromRoot);
    expect(fromRoot.endsWith(path.join("packages", "nova-state", "defender-knowledge", "knowledge-v1.jsonl"))).toBe(true);
  });

  it("names what it looked for instead of leaving a bare ENOENT", async () => {
    await expect(resolveCorpus(path.parse(process.cwd()).root)).rejects.toThrow(/Defender corpus not found[\s\S]*knowledge-v1\.jsonl/);
  });

  it("fails closed when signing authority is absent", async () => {
    delete process.env.DEFENDER_BRAIN_SIGNING_KEY;
    process.env.DEFENDER_BRAIN_SEQUENCE = "1";
    process.env.DEFENDER_BRAIN_KEY_ID = "key";
    await expect(signedDefenderManifest("https://feed.example")).rejects.toThrow("SIGNING_KEY");
  });
});

function set(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
