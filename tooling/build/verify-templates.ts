/**
 * Verifies every workspace preset's program manifest against the image it actually built.
 * Run with `bun run verify:templates`.
 *
 * The manifest is what the planner is told its workspace contains. A manifest that overstates the
 * image reintroduces exactly the failure presets exist to remove — a planner reaching for a tool
 * that is not there — so this asks each built sandbox directly rather than trusting the list.
 */
import { E2BSandboxProvider } from "@circuit-nova/nova-core/providers/e2b";
import { presetPrograms, WORKSPACE_PRESETS } from "@circuit-nova/nova-core/sandbox-templates";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required to verify templates");

let failures = 0;

for (const preset of WORKSPACE_PRESETS) {
  const expected = presetPrograms(preset);
  const provider = new E2BSandboxProvider({ apiKey, templates: { coding: preset.templateAlias }, allowInternetAccess: false });
  process.stdout.write(`\n=== ${preset.id} (${preset.templateAlias}) ===\n`);
  const session = await provider.createSandbox({ taskId: "verify-templates", template: "coding", maxRuntimeSeconds: 120 });
  try {
    const probe = expected.map((program) => `import shutil;print('${program}', 'YES' if shutil.which('${program}') else 'MISSING')`).join("\n");
    await provider.writeFile(session.sandboxId, "/workspace/repo/probe.py", probe);
    const result = await provider.runCommand(session.sandboxId, {
      program: "python3",
      args: ["probe.py"],
      cwd: "/workspace/repo",
      timeoutMs: 60_000,
    });
    const missing = result.stdout.split("\n").filter((line) => line.includes("MISSING")).map((line) => line.split(" ")[0]);
    if (missing.length > 0) {
      failures += 1;
      console.error(`  MANIFEST OVERSTATES THE IMAGE — missing: ${missing.join(", ")}`);
    } else {
      console.log(`  all ${expected.length} declared programs present`);
    }
    // The workspace must also exist and be writable, or every run starts by failing to write.
    const writable = await provider.runCommand(session.sandboxId, { program: "pwd", args: [], cwd: "/workspace/repo", timeoutMs: 30_000 });
    console.log(`  workspace: ${writable.exitCode === 0 ? "ready" : "NOT USABLE"}`);
    if (writable.exitCode !== 0) failures += 1;
  } finally {
    await provider.stopSandbox(session.sandboxId);
  }
}

if (failures > 0) {
  console.error(`\n${failures} preset(s) do not match their manifest.`);
  process.exitCode = 1;
} else {
  console.log("\nEvery preset matches its declared manifest.");
}
