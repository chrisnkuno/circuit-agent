import { describe, expect, it } from "vitest";
import { decryptVaultValue, encryptVaultValue, parseVaultKey, secretHash } from "./credential-vault";

describe("credential vault", () => {
  it("encrypts token material with authenticated encryption", () => {
    const key = Buffer.alloc(32, 7);
    const token = { accessToken: "access-secret", refreshToken: "refresh-secret" };
    const envelope = encryptVaultValue(token, key);
    expect(JSON.stringify(envelope)).not.toContain("secret");
    expect(decryptVaultValue(envelope, key)).toEqual(token);
  });

  it("rejects missing or malformed vault keys and tampered ciphertext", () => {
    expect(() => parseVaultKey(undefined)).toThrow("not configured");
    expect(() => parseVaultKey(Buffer.alloc(31).toString("base64"))).toThrow("32-byte key");
    const key = Buffer.alloc(32, 1);
    const envelope = encryptVaultValue({ value: 1 }, key);
    expect(() => decryptVaultValue({ ...envelope, authTag: Buffer.alloc(16).toString("base64") }, key)).toThrow();
  });

  it("hashes webhook and OAuth secrets without persisting them", () => {
    expect(secretHash("secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretHash("secret")).toBe(secretHash("secret"));
  });
});
