"use node";

import { describeArtifact, type ArtifactStore, type ArtifactWrite, type ArtifactReference } from "../../lib/artifacts";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Writes worker evidence through the recordArtifact lease-owned mutation. */
export function createConvexArtifactStore(ctx: ActionCtx, workerId: string): ArtifactStore {
  return {
    async put(artifact: ArtifactWrite): Promise<ArtifactReference> {
      const description = describeArtifact(artifact);
      await ctx.runMutation(internal.agentRuns.recordArtifact, {
        runId: artifact.runId as Id<"agentRuns">,
        stepId: artifact.stepId as Id<"agentSteps">,
        workerId,
        kind: description.kind,
        mediaType: artifact.mediaType,
        reference: description.reference,
        sha256: description.sha256,
        byteLength: description.byteLength,
      });
      return description;
    },
  };
}
