import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { RepositoryProvider, RepositoryTarget, ResolvedRepositoryRef, PatchBranchRequest, PullRequestRequest, PullRequestReceipt } from "./contracts";

const GITHUB_API = "https://api.github.com";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const PATCH_BRANCH_PATTERN = /^circuit-nova\/[a-z0-9][a-z0-9-]{0,80}$/;

type Fetch = typeof fetch;

export type GitHubAppConfig = {
  appId: string;
  privateKeyPem: string;
};

export type InstallationTokenBundle = {
  token: string;
  expiresAt: number;
};

export type RepositoryTrust = "trusted" | "untrusted";

export type InstallationDetails = {
  installationId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
};

/** Builds the App's own installation-picker URL; the resulting installation is recorded only from the signed webhook, never from this redirect. */
export function buildInstallationUrl(appSlug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Builds the short-lived RS256 JWT that authenticates as the GitHub App itself (max 10-minute lifetime per GitHub's app-auth contract). */
export function buildAppJwt(config: GitHubAppConfig, now = Date.now()): string {
  if (!config.appId.trim()) throw new Error("GITHUB_APP_ID is required");
  if (!config.privateKeyPem.trim()) throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  const issuedAt = Math.floor(now / 1_000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = base64Url(signer.sign(config.privateKeyPem));
  return `${header}.${payload}.${signature}`;
}

/** Mints a short-lived installation access token (typically one hour); only the installation ID is ever persisted. */
export async function mintInstallationToken(installationId: string, appJwt: string, request: Fetch = fetch): Promise<InstallationTokenBundle> {
  const response = await request(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.token !== "string" || typeof body.expires_at !== "string") throw new Error(`GitHub installation token request failed (${response.status})`);
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/** Fetches authoritative installation identity directly from GitHub using the App's own JWT; never trust these fields if they arrive from a browser redirect. */
export async function getInstallationDetails(installationId: string, appJwt: string, request: Fetch = fetch): Promise<InstallationDetails> {
  const response = await request(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, { headers: { authorization: `Bearer ${appJwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  const body = await readJson(response);
  if (!response.ok || typeof body.id !== "number" || typeof body.account?.login !== "string") throw new Error(`GitHub installation lookup failed (${response.status})`);
  const accountType = body.account.type === "Organization" ? "Organization" : "User";
  const repositorySelection = body.repository_selection === "all" ? "all" : "selected";
  return { installationId: String(body.id), accountLogin: body.account.login, accountType, repositorySelection };
}

/** Has the App remove its own installation; requires the App JWT, not an installation token. */
export async function uninstallApp(installationId: string, appJwt: string, request: Fetch = fetch): Promise<void> {
  const response = await request(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, { method: "DELETE", headers: { authorization: `Bearer ${appJwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub app uninstall failed (${response.status})`);
}

export async function listInstallationRepositories(installationToken: string, request: Fetch = fetch): Promise<string[]> {
  const response = await request(`${GITHUB_API}/installation/repositories?per_page=100`, { headers: { ...bearer(installationToken), accept: "application/vnd.github+json" } });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`GitHub repository list failed (${response.status})`);
  const repositories = Array.isArray(body.repositories) ? body.repositories : [];
  return repositories.map((repo: any) => String(repo.full_name));
}

export async function resolveRepositoryRef(input: { installationToken: string; owner: string; repo: string; ref: string }, request: Fetch = fetch): Promise<ResolvedRepositoryRef> {
  validateOwnerRepo(input.owner, input.repo);
  const response = await request(`${GITHUB_API}/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}`, { headers: { ...bearer(input.installationToken), accept: "application/vnd.github+json" } });
  const body = await readJson(response);
  if (!response.ok || typeof body.sha !== "string") throw new Error(`GitHub ref resolution failed for ${input.owner}/${input.repo}@${input.ref} (${response.status})`);
  return { owner: input.owner, repo: input.repo, ref: input.ref, sha: body.sha };
}

/**
 * Mirrors the trusted/untrusted split mature coding-agent GitHub workflows use: only the
 * repository's own default branch, on a repository the installation was actually granted and
 * the organization explicitly allowed, may drive an unattended patch/verify loop. A fork, an
 * arbitrary contributor ref, or an unlisted repository must stay untrusted; untrusted work is
 * still readable but can never open a patch branch or a pull request.
 */
export function classifyRefTrust(input: { defaultBranch: string; ref: string; isFork: boolean; allowedRepositories: string[]; fullName: string }): RepositoryTrust {
  if (input.isFork) return "untrusted";
  if (!input.allowedRepositories.includes(input.fullName)) return "untrusted";
  if (input.ref !== input.defaultBranch) return "untrusted";
  return "trusted";
}

export async function openPatchBranch(input: { installationToken: string; owner: string; repo: string; branchName: string; fromSha: string }, request: Fetch = fetch): Promise<void> {
  validateOwnerRepo(input.owner, input.repo);
  if (!PATCH_BRANCH_PATTERN.test(input.branchName)) throw new Error("Patch branch name must be namespaced under circuit-nova/ and use lowercase letters, digits, and hyphens");
  const response = await request(`${GITHUB_API}/repos/${input.owner}/${input.repo}/git/refs`, {
    method: "POST",
    headers: { ...bearer(input.installationToken), "content-type": "application/json", accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: input.fromSha }),
  });
  // 422 means the branch already exists, which is the expected outcome of a retried step.
  if (!response.ok && response.status !== 422) throw new Error(`GitHub branch creation failed (${response.status})`);
}

/** Executes a pull request the caller has already gated behind human approval; reuses an existing PR for the same head branch instead of opening a duplicate. */
export async function openPullRequest(input: { installationToken: string; owner: string; repo: string; title: string; body: string; head: string; base: string }, request: Fetch = fetch): Promise<PullRequestReceipt> {
  validateOwnerRepo(input.owner, input.repo);
  if (!input.head.startsWith("circuit-nova/")) throw new Error("Pull requests may only be opened from circuit-nova/-namespaced branches");
  const existing = await request(`${GITHUB_API}/repos/${input.owner}/${input.repo}/pulls?head=${input.owner}:${encodeURIComponent(input.head)}&state=all`, { headers: { ...bearer(input.installationToken), accept: "application/vnd.github+json" } });
  const existingBody = await readJson(existing);
  if (existing.ok && Array.isArray(existingBody) && existingBody.length > 0) {
    return { number: existingBody[0].number, htmlUrl: String(existingBody[0].html_url), state: String(existingBody[0].state) };
  }
  const response = await request(`${GITHUB_API}/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    headers: { ...bearer(input.installationToken), "content-type": "application/json", accept: "application/vnd.github+json" },
    body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.number !== "number") throw new Error(`GitHub pull request creation failed (${response.status})`);
  return { number: body.number, htmlUrl: String(body.html_url), state: String(body.state) };
}

/** Verifies GitHub's HMAC-SHA256 webhook signature; an installation event without a valid signature must fail closed. */
export function verifyWebhookSignature(payload: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export type GitHubRepositoryProviderOptions = {
  appId: string;
  privateKeyPem: string;
  allowedRepositories: string[];
};

/** Concrete GitHub App adapter: mints a fresh installation token per call and never persists one. */
export class GitHubRepositoryProvider implements RepositoryProvider {
  constructor(private readonly options: GitHubRepositoryProviderOptions, private readonly request: Fetch = fetch, private readonly now: () => number = Date.now) {
    if (!options.appId.trim()) throw new Error("GITHUB_APP_ID is required");
    if (!options.privateKeyPem.trim()) throw new Error("GITHUB_APP_PRIVATE_KEY is required");
  }

  async resolveRef(target: RepositoryTarget): Promise<ResolvedRepositoryRef> {
    this.assertAllowed(target.owner, target.repo);
    const token = await this.mintToken(target.installationId);
    return resolveRepositoryRef({ installationToken: token, owner: target.owner, repo: target.repo, ref: target.ref }, this.request);
  }

  async createPatchBranch(installationId: string, request: PatchBranchRequest): Promise<void> {
    this.assertAllowed(request.owner, request.repo);
    const token = await this.mintToken(installationId);
    await openPatchBranch({ installationToken: token, ...request }, this.request);
  }

  async createPullRequest(installationId: string, request: PullRequestRequest): Promise<PullRequestReceipt> {
    this.assertAllowed(request.owner, request.repo);
    const token = await this.mintToken(installationId);
    return openPullRequest({ installationToken: token, ...request }, this.request);
  }

  private async mintToken(installationId: string): Promise<string> {
    const jwt = buildAppJwt({ appId: this.options.appId, privateKeyPem: this.options.privateKeyPem }, this.now());
    const bundle = await mintInstallationToken(installationId, jwt, this.request);
    return bundle.token;
  }

  private assertAllowed(owner: string, repo: string): void {
    const fullName = `${owner}/${repo}`;
    if (!this.options.allowedRepositories.includes(fullName)) throw new Error(`${fullName} is not in the organization's approved repository list`);
  }
}

function validateOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_PATTERN.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  if (!REPO_PATTERN.test(repo)) throw new Error(`Invalid GitHub repository name: ${repo}`);
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function readJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return {}; }
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
