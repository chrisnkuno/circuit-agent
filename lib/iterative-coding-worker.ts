import type { AgentRuntimeControl, AgentRuntimeEvent, AgentRuntimeRequest, AgentRuntimeResult, AgentTool, AgentToolCall, AgentTurnProvider } from "./agent-runtime";
import { BoundedAgentRuntime } from "./agent-runtime";
import { createE2BCodingTools, initializeE2BCodingWorkspace } from "./e2b-coding-tools";
import type { ArtifactReference, ArtifactStore, ArtifactWrite } from "./artifacts";
import type { ModelPriceCatalog } from "./model-cost";
import type { InteractiveCodingSandboxProvider } from "./providers/contracts";

export type IterativeCodingWorkerRequest = AgentRuntimeRequest & { sandboxRuntimeSeconds: number };

export type IterativeCodingWorkerControl = {
  heartbeat(stepId: string): Promise<void>;
  isCancellationRequested(runId: string): Promise<boolean>;
  isToolCallApproved(runId: string, stepId: string, call: AgentToolCall, tool: AgentTool): Promise<boolean>;
  persistRuntimeEvent(runId: string, stepId: string, event: AgentRuntimeEvent): Promise<void>;
};

export type IterativeCodingWorkerResult = AgentRuntimeResult & { artifactReferences: ArtifactReference[] };

export type IterativeCodingWorkerDependencies = {
  model: AgentTurnProvider;
  sandbox: InteractiveCodingSandboxProvider;
  artifacts: ArtifactStore;
  control: IterativeCodingWorkerControl;
  prices: ModelPriceCatalog;
};

function artifact(request: IterativeCodingWorkerRequest, value: Omit<ArtifactWrite, "taskId" | "runId" | "stepId">): ArtifactWrite {
  return { taskId: request.taskId, runId: request.runId, stepId: request.stepId, ...value };
}

/** Composes the bounded multi-turn runtime with one short-lived E2B coding workspace. */
export class IterativeCodingAgentWorker {
  constructor(private readonly dependencies: IterativeCodingWorkerDependencies) {}

  async execute(request: IterativeCodingWorkerRequest): Promise<IterativeCodingWorkerResult> {
    if (!Number.isInteger(request.sandboxRuntimeSeconds) || request.sandboxRuntimeSeconds < 1 || request.sandboxRuntimeSeconds > 3_600) {
      throw new Error("sandboxRuntimeSeconds must be between 1 and 3600");
    }
    await this.dependencies.control.heartbeat(request.stepId);
    if (await this.dependencies.control.isCancellationRequested(request.runId)) {
      return {
        status: "cancelled", summary: "Run cancelled before sandbox creation.", messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        actualModelRwf: 0, iterations: 0, toolCallsExecuted: 0, artifactReferences: [],
      };
    }

    const session = await this.dependencies.sandbox.createSandbox({ taskId: request.taskId, template: "coding", maxRuntimeSeconds: request.sandboxRuntimeSeconds });
    const events: AgentRuntimeEvent[] = [];
    try {
      await initializeE2BCodingWorkspace({ sandbox: this.dependencies.sandbox, sandboxId: session.sandboxId, workspaceRoot: "/workspace/repo" });
      const control: AgentRuntimeControl = {
        heartbeat: () => this.dependencies.control.heartbeat(request.stepId),
        isCancellationRequested: () => this.dependencies.control.isCancellationRequested(request.runId),
        isToolCallApproved: (call, tool) => this.dependencies.control.isToolCallApproved(request.runId, request.stepId, call, tool),
        persistEvent: async (event) => {
          events.push(event);
          await this.dependencies.control.persistRuntimeEvent(request.runId, request.stepId, event);
        },
      };
      const runtime = new BoundedAgentRuntime({
        model: this.dependencies.model,
        tools: createE2BCodingTools({ sandbox: this.dependencies.sandbox, sandboxId: session.sandboxId, workspaceRoot: "/workspace/repo" }),
        control,
        prices: this.dependencies.prices,
      });
      const result = await runtime.execute(request);
      const eventArtifact = await this.dependencies.artifacts.put(artifact(request, {
        kind: "command_log", mediaType: "application/json", content: JSON.stringify(events, null, 2),
      }));
      const summaryArtifact = await this.dependencies.artifacts.put(artifact(request, {
        kind: "review_summary", mediaType: "application/json", content: JSON.stringify({ status: result.status, summary: result.summary, usage: result.usage, actualModelRwf: result.actualModelRwf, iterations: result.iterations, toolCallsExecuted: result.toolCallsExecuted }, null, 2),
      }));
      return { ...result, artifactReferences: [eventArtifact, summaryArtifact] };
    } finally {
      await this.dependencies.sandbox.stopSandbox(session.sandboxId);
    }
  }
}
