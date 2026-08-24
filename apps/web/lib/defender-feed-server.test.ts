import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { defenderFeedPayload } from "@circuit-nova/nova-core/nova-cli/defender-feed";
import { defenderCorpus, signedDefenderManifest } from "./defender-feed-server";

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
