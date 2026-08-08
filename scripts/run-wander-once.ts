/**
 * One-shot live Wander: Exa literature → coding sandbox lab → print-ready HTML report.
 *
 * Usage (from repo root, with .env.local loaded):
 *   bun scripts/run-wander-once.ts [topic]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeArtifact, type ArtifactStore, type ArtifactWrite } from "../lib/artifacts";
import { CodingAgentWorker } from "../lib/coding-worker";
import { buildStepRequest } from "../lib/coding-step-request";
import { createCodingModelProvider, createE2BProvider, createModelPriceCatalog } from "../packages/agent-core/src/providers/factory";
import { createExaClient } from "../packages/agent-core/src/providers/exa";
import { buildWanderObjective, resolveExecutionSession, WANDER_LAB_FILES } from "../packages/agent-core/src/wander";
import { gatherWanderEvidence } from "../lib/wander-research";
import { assembleWanderReport, WANDER_REPORT_PATH } from "../lib/wander-report";

const topic = (process.argv.slice(2).join(" ").trim() || "how sleep stages affect memory consolidation").slice(0, 140);
const outDir = path.join(process.cwd(), "tmp", `wander-${Date.now()}`);

function loadEnvLocal(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const text = require("node:fs").readFileSync(path.join(process.cwd(), ".env.local"), "utf8") as string;
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // .env.local optional when vars are already exported
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const env = process.env as Record<string, string | undefined>;
  const prices = createModelPriceCatalog(env);
  const model = createCodingModelProvider(env);
  const sandbox = createE2BProvider(env);
  const exa = createExaClient(env);
  if (!prices || !model || !sandbox) {
    throw new Error("Missing coding providers (model prices, coding model, or E2B). Check .env.local.");
  }
  if (!exa) throw new Error("EXA_API_KEY is required for a live Wander literature scout.");

  const objective = buildWanderObjective(topic);
  const session = resolveExecutionSession(objective);
  console.log(`Topic: ${topic}`);
  console.log(`Session: lease=${session.claimLeaseMs / 1000}s sandbox=${session.sandboxRuntimeSeconds}s modelTimeout=${session.modelTimeoutMs / 1000}s`);

  console.log("Scouting literature via Exa (budget: 1 search)...");
  const dossier = await gatherWanderEvidence({ topic, client: exa });
  console.log(`Exa: calls=${dossier.exaCalls} sources=${dossier.sourceCount}`);

  const request = buildStepRequest("Wander once", objective, `wander_${Date.now()}`, "implement", undefined, dossier.briefMarkdown);
  const writes: ArtifactWrite[] = [];
  const artifacts: ArtifactStore = {
    put: async (value) => {
      writes.push(value);
      return describeArtifact(value, `local-${writes.length}`);
    },
  };

  const worker = new CodingAgentWorker({
    model,
    sandbox,
    artifacts,
    control: {
      heartbeat: async () => undefined,
      isCancellationRequested: async () => false,
    },
    prices,
  });

  console.log("Running lab in E2B sandbox...");
  const started = Date.now();
  const result = await worker.execute({
    ...request,
    runId: `run_${Date.now()}`,
    sandboxRuntimeSeconds: session.sandboxRuntimeSeconds,
    modelReservationRwf: 2_000,
  });
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  console.log(`Worker status=${result.status} elapsed=${elapsedSec}s rwf=${result.actualModelRwf} commands=${result.commandsExecuted}`);
  console.log(`Summary: ${result.summary}`);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "EVIDENCE.md"), dossier.briefMarkdown);
  await writeFile(path.join(outDir, "result.json"), JSON.stringify({ result, elapsedSec, topic, sourceCount: dossier.sourceCount }, null, 2));

  const byPath = new Map<string, string>();
  for (const write of writes) {
    if (write.kind === "workspace_file" && write.path) {
      byPath.set(write.path.replace(/^\//, ""), write.content);
      const filePath = path.join(outDir, path.basename(write.path));
      await writeFile(filePath, write.content);
    }
  }

  const harvested = writes.find((write) => write.path === WANDER_REPORT_PATH);
  if (harvested) {
    console.log(`\nDeliverable: ${path.join(outDir, "REPORT.html")}`);
  } else {
    // Fallback if an older worker path didn't harvest — assemble locally for inspection.
    const files = [...byPath.entries()].map(([filePath, content]) => ({ path: filePath, content }));
    const report = assembleWanderReport({ objective, files, evidenceFallback: dossier.briefMarkdown });
    if (report) {
      await writeFile(path.join(outDir, "REPORT.html"), report.html);
      console.log(`\nDeliverable (assembled locally): ${path.join(outDir, "REPORT.html")}`);
    } else {
      console.warn("No CONSENSUS.md — harvest report unavailable.");
      console.warn(`Expected lab files under ${WANDER_LAB_FILES.consensus}`);
    }
  }
  console.log("Open in a browser and Print → Save as PDF.");
  if (result.status !== "completed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
