import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type VaultEnvelope = {
  algorithm: "aes-256-gcm";
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export function parseVaultKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error("CONNECTOR_VAULT_KEY is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("CONNECTOR_VAULT_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptVaultValue(value: unknown, key: Buffer, keyVersion = 1): VaultEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptVaultValue<T>(envelope: VaultEnvelope, key: Buffer): T {
  if (envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported vault algorithm");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
