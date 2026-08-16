import { describe, expect, it } from "vitest";
import { COMBINED_SECRET_PATTERN, findSecretsInLine, maskSecret, SECRET_PATTERNS, SEVERITY_RANK } from "./secret-scan";

describe("findSecretsInLine", () => {
  it("finds an AWS access key, ranked critical", () => {
    const found = findSecretsInLine('const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(found).toEqual([{ kind: "AWS access key", masked: "AKIA…MNOP (20 chars)", severity: "critical" }]);
  });

  it("finds a GitHub token", () => {
    const found = findSecretsInLine(`GITHUB_TOKEN=ghp_${"a".repeat(36)}`);
    expect(found.some((f) => f.kind === "GitHub token")).toBe(true);
  });

  it("finds a private key block", () => {
    const found = findSecretsInLine("-----BEGIN RSA PRIVATE KEY-----");
    expect(found.some((f) => f.kind === "Private key block")).toBe(true);
  });

  it("finds a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const found = findSecretsInLine(`Authorization: Bearer ${jwt}`);
    expect(found.some((f) => f.kind === "JSON Web Token")).toBe(true);
  });

  it("finds a lowercase and an uppercase credential-looking assignment", () => {
    expect(findSecretsInLine('api_key = "abcdefghij1234567890"').length).toBeGreaterThan(0);
    expect(findSecretsInLine('API_KEY = "abcdefghij1234567890"').length).toBeGreaterThan(0);
  });

  it("finds nothing in an ordinary line", () => {
    expect(findSecretsInLine("export const port = 3000;")).toEqual([]);
  });

  it("does not flag a short, harmless value as a credential-looking assignment", () => {
    // The 16-char minimum exists so `token = 'x'` (a variable named token, not a secret) is not a
    // false positive on every codebase that happens to use that word as an identifier.
    expect(findSecretsInLine('token = "short"')).toEqual([]);
  });
});

describe("severity", () => {
  it("gives every pattern a severity, and ranks critical above high above medium", () => {
    for (const pattern of SECRET_PATTERNS) expect(["critical", "high", "medium"]).toContain(pattern.severity);
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeLessThan(SEVERITY_RANK.medium);
  });

  it("ranks a private key and a generic credential-looking assignment at opposite ends", () => {
    const key = findSecretsInLine("-----BEGIN RSA PRIVATE KEY-----")[0];
    const generic = findSecretsInLine('api_key = "abcdefghij1234567890"')[0];
    expect(key.severity).toBe("critical");
    expect(generic.severity).toBe("medium");
    expect(SEVERITY_RANK[key.severity]).toBeLessThan(SEVERITY_RANK[generic.severity]);
  });
});

describe("maskSecret", () => {
  it("keeps the ends and hides the middle, for a long value", () => {
    expect(maskSecret("AKIAABCDEFGHIJKLMNOP")).toBe("AKIA…MNOP (20 chars)");
  });

  it("redacts a short value completely rather than exposing most of it via the mask", () => {
    expect(maskSecret("short")).toBe("[redacted]");
  });

  it("never contains the original value as a substring, for anything long enough to mask", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(maskSecret(secret)).not.toContain(secret.slice(4, -4));
  });
});

describe("COMBINED_SECRET_PATTERN", () => {
  it("matches a line that any individual pattern would, so one tree walk finds everything", () => {
    expect(COMBINED_SECRET_PATTERN.test("AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(COMBINED_SECRET_PATTERN.test("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("matches nothing an ordinary line would trigger", () => {
    expect(COMBINED_SECRET_PATTERN.test("export const port = 3000;")).toBe(false);
  });
});
