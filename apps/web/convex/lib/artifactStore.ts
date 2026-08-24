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
      // The bytes, not just a hash of them. Recording a sha256 for content nobody kept meant every
      // run produced evidence that could never be read back — the code a step wrote died with its
      // sandbox. Storage happens here, in the action, because only an action can upload a blob.
      const storageId = await ctx.storage.store(new Blob([artifact.content], { type: artifact.mediaType }));
      await ctx.runMutation(internal.agentRuns.recordArtifact, {
        storageId,
        path: artifact.path,
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
