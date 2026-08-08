/**
 * External services are deliberately represented by narrow contracts. Provider
 * SDKs belong behind these interfaces so task state remains portable and testable.
 */
export type PaymentAuthorizationRequest = {
  amountRwf: number;
  idempotencyKey: string;
  taskId: string;
};

export type PaymentAuthorization = {
  providerReference: string;
  status: "authorized" | "requires_action" | "failed";
};

export interface PaymentProvider {
  authorizeTaskCap(request: PaymentAuthorizationRequest): Promise<PaymentAuthorization>;
  captureTaskCost(providerReference: string, amountRwf: number, idempotencyKey: string): Promise<void>;
  releaseTaskCap(providerReference: string, idempotencyKey: string): Promise<void>;
}

export type SandboxRequest = {
  taskId: string;
  template: "coding" | "browser" | "data";
  maxRuntimeSeconds: number;
};

export type SandboxSession = {
  sandboxId: string;
  status: "created" | "running" | "failed";
};

export interface SandboxProvider {
  createSandbox(request: SandboxRequest): Promise<SandboxSession>;
  /**
   * Releases the sandbox between steps while preserving its filesystem, so the next step of the
   * same run continues in the workspace the previous one left behind instead of an empty one.
   * Backends differ in what this costs: E2B pauses (unbilled, uncounted against concurrency, and
   * resumable in about a second), while a container backend simply keeps the container.
   */
  suspendSandbox(sandboxId: string): Promise<void>;
  /** Destroys the sandbox and everything in it. Nothing survives, and nothing keeps accruing. */
  stopSandbox(sandboxId: string): Promise<void>;
}

export type SandboxCommand = {
  program: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
};

export type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface ExecutableSandboxProvider extends SandboxProvider {
  runCommand(sandboxId: string, command: SandboxCommand): Promise<SandboxCommandResult>;
}

export interface CodingSandboxProvider extends ExecutableSandboxProvider {
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
}

export interface InteractiveCodingSandboxProvider extends CodingSandboxProvider {
  readFile(sandboxId: string, path: string): Promise<string>;
}

export type RepositoryTarget = {
  installationId: string;
  owner: string;
  repo: string;
  ref: string;
};

export type ResolvedRepositoryRef = {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
};

export type PatchBranchRequest = {
  owner: string;
  repo: string;
  branchName: string;
  fromSha: string;
};

export type PullRequestRequest = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
};

export type PullRequestReceipt = {
  number: number;
  htmlUrl: string;
  state: string;
};

/** GitHub App-backed repository access. Every method mints a fresh, short-lived installation token; nothing here is persisted. */
export interface RepositoryProvider {
  resolveRef(target: RepositoryTarget): Promise<ResolvedRepositoryRef>;
  createPatchBranch(installationId: string, request: PatchBranchRequest): Promise<void>;
  createPullRequest(installationId: string, request: PullRequestRequest): Promise<PullRequestReceipt>;
}
