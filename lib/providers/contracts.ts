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
