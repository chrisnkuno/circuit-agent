import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAppJwt,
  buildInstallationUrl,
  classifyRefTrust,
  getInstallationDetails,
  GitHubRepositoryProvider,
  listInstallationRepositories,
  mintInstallationToken,
  openPatchBranch,
  openPullRequest,
  resolveRepositoryRef,
  uninstallApp,
  verifyWebhookSignature,
} from "./github";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("buildInstallationUrl", () => {
  it("points at the App's installation picker with a state token", () => {
    const url = new URL(buildInstallationUrl("circuit-nova", "state-123"));
    expect(url.pathname).toBe("/apps/circuit-nova/installations/new");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("buildAppJwt", () => {
  it("produces a validly signed, short-lived RS256 JWT", () => {
    const now = Date.parse("2026-08-05T12:00:00Z");
    const token = buildAppJwt({ appId: "12345", privateKeyPem: privateKey }, now);
    const [header, payload, signature] = token.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeSegment(payload);
    expect(claims.iss).toBe("12345");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("rejects a missing app ID or private key", () => {
    expect(() => buildAppJwt({ appId: "", privateKeyPem: privateKey })).toThrow("GITHUB_APP_ID");
    expect(() => buildAppJwt({ appId: "12345", privateKeyPem: "" })).toThrow("GITHUB_APP_PRIVATE_KEY");
  });
});

describe("mintInstallationToken", () => {
  it("requests a scoped installation token with the app JWT", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ token: "ghs_abc", expires_at: "2026-08-05T13:00:00Z" }), { status: 201 }));
    const bundle = await mintInstallationToken("999", "app-jwt", request as unknown as typeof fetch);
    expect(bundle).toEqual({ token: "ghs_abc", expiresAt: Date.parse("2026-08-05T13:00:00Z") });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/999/access_tokens");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer app-jwt");
  });

  it("fails closed on a non-2xx response", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(mintInstallationToken("999", "app-jwt", request as unknown as typeof fetch)).rejects.toThrow("404");
  });
});

describe("getInstallationDetails", () => {
  it("resolves authoritative installation identity from GitHub, not from caller-supplied values", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: 555, account: { login: "acme", type: "Organization" }, repository_selection: "selected" }), { status: 200 }));
    await expect(getInstallationDetails("555", "app-jwt", request as unknown as typeof fetch)).resolves.toEqual({ installationId: "555", accountLogin: "acme", accountType: "Organization", repositorySelection: "selected" });
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer app-jwt");
  });

  it("fails closed when GitHub cannot confirm the installation", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(getInstallationDetails("555", "app-jwt", request as unknown as typeof fetch)).rejects.toThrow("404");
  });
});

describe("uninstallApp", () => {
  it("issues an authenticated DELETE for the installation", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    await uninstallApp("555", "app-jwt", request as unknown as typeof fetch);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/555");
    expect(init.method).toBe("DELETE");
  });

  it("treats an already-removed installation (404) as success", async () => {
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(uninstallApp("555", "app-jwt", request as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe("listInstallationRepositories", () => {
  it("returns full repository names", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ repositories: [{ full_name: "acme/api" }, { full_name: "acme/web" }] }), { status: 200 }));
    await expect(listInstallationRepositories("token", request as unknown as typeof fetch)).resolves.toEqual(["acme/api", "acme/web"]);
  });
});

describe("resolveRepositoryRef", () => {
  it("resolves a ref to its commit sha", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 }));
    await expect(resolveRepositoryRef({ installationToken: "token", owner: "acme", repo: "api", ref: "main" }, request as unknown as typeof fetch)).resolves.toEqual({ owner: "acme", repo: "api", ref: "main", sha: "deadbeef" });
  });

  it("rejects an invalid owner or repository name before ever calling GitHub", async () => {
    const request = vi.fn();
    await expect(resolveRepositoryRef({ installationToken: "token", owner: "../evil", repo: "api", ref: "main" }, request as unknown as typeof fetch)).rejects.toThrow("Invalid GitHub owner");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("classifyRefTrust", () => {
  const base = { defaultBranch: "main", ref: "main", isFork: false, allowedRepositories: ["acme/api"], fullName: "acme/api" };

  it("trusts only the default branch of an explicitly allowed, non-fork repository", () => {
    expect(classifyRefTrust(base)).toBe("trusted");
  });

  it("distrusts forks even on the default branch", () => {
    expect(classifyRefTrust({ ...base, isFork: true })).toBe("untrusted");
  });

  it("distrusts repositories outside the organization's allow-list", () => {
    expect(classifyRefTrust({ ...base, allowedRepositories: ["acme/other"] })).toBe("untrusted");
  });

  it("distrusts a non-default ref", () => {
    expect(classifyRefTrust({ ...base, ref: "feature/x" })).toBe("untrusted");
  });
});

describe("openPatchBranch", () => {
  it("only accepts circuit-nova/-namespaced branch names", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(openPatchBranch({ installationToken: "token", owner: "acme", repo: "api", branchName: "feature/x", fromSha: "sha" }, request as unknown as typeof fetch)).rejects.toThrow("circuit-nova/");
    expect(request).not.toHaveBeenCalled();
  });

  it("treats an already-existing branch (422) as success", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 422 }));
    await expect(openPatchBranch({ installationToken: "token", owner: "acme", repo: "api", branchName: "circuit-nova/fix-1", fromSha: "sha" }, request as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe("openPullRequest", () => {
  it("rejects a head branch outside the circuit-nova/ namespace", async () => {
    const request = vi.fn();
    await expect(openPullRequest({ installationToken: "token", owner: "acme", repo: "api", title: "t", body: "b", head: "feature/x", base: "main" }, request as unknown as typeof fetch)).rejects.toThrow("circuit-nova/");
    expect(request).not.toHaveBeenCalled();
  });

  it("reuses an existing pull request for the same head branch instead of duplicating it", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/acme/api/pull/7", state: "open" }]), { status: 200 }));
    const result = await openPullRequest({ installationToken: "token", owner: "acme", repo: "api", title: "t", body: "b", head: "circuit-nova/fix-1", base: "main" }, request as unknown as typeof fetch);
    expect(result).toEqual({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", state: "open" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("creates a new pull request when none exists for the head branch", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 8, html_url: "https://github.com/acme/api/pull/8", state: "open" }), { status: 201 }));
    const result = await openPullRequest({ installationToken: "token", owner: "acme", repo: "api", title: "t", body: "b", head: "circuit-nova/fix-1", base: "main" }, request as unknown as typeof fetch);
    expect(result.number).toBe(8);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed payload and rejects a tampered one", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "webhook-secret";
    const payload = JSON.stringify({ action: "created" });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload.replace("created", "deleted"), signature, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, null, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha1=notsha256", secret)).toBe(false);
  });
});

describe("GitHubRepositoryProvider", () => {
  it("refuses to act on a repository outside the organization's allow-list", async () => {
    const provider = new GitHubRepositoryProvider({ appId: "1", privateKeyPem: privateKey, allowedRepositories: ["acme/api"] });
    await expect(provider.resolveRef({ installationId: "9", owner: "acme", repo: "other", ref: "main" })).rejects.toThrow("approved repository list");
  });

  it("mints a fresh installation token per call and never reuses it across calls", async () => {
    const tokens = ["ghs_first", "ghs_second"];
    let mintCount = 0;
    const request = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        mintCount += 1;
        return new Response(JSON.stringify({ token: tokens[mintCount - 1], expires_at: "2026-08-05T13:00:00Z" }), { status: 201 });
      }
      return new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 });
    });
    const provider = new GitHubRepositoryProvider({ appId: "1", privateKeyPem: privateKey, allowedRepositories: ["acme/api"] }, request as unknown as typeof fetch);
    await provider.resolveRef({ installationId: "9", owner: "acme", repo: "api", ref: "main" });
    await provider.resolveRef({ installationId: "9", owner: "acme", repo: "api", ref: "main" });
    expect(mintCount).toBe(2);
    const refCalls = request.mock.calls.filter(([url]) => String(url).includes("/commits/")) as unknown as [string, RequestInit & { headers: Record<string, string> }][];
    expect(refCalls[0][1].headers.authorization).toBe("Bearer ghs_first");
    expect(refCalls[1][1].headers.authorization).toBe("Bearer ghs_second");
  });
});
