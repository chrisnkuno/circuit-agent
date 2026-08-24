import { promises as fs } from "node:fs";
import path from "node:path";

export function sanitizeErrorField(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/-]/g, "-").slice(0, 160);
}

async function main(): Promise<void> {
  const [phase = "unknown", subject = "unknown", rawExitCode = "1"] =
    process.argv.slice(2);
  const exitCode = Number.parseInt(rawExitCode, 10);
  const file = path.resolve(
    import.meta.dirname,
    "../..",
    "reliability",
    "errors.json",
  );
  const existing = await fs
    .readFile(file, "utf8")
    .then((value) => JSON.parse(value) as unknown[])
    .catch(() => [] as unknown[]);
  existing.push({
    recordedAt: new Date().toISOString(),
    phase: sanitizeErrorField(phase),
    subject: sanitizeErrorField(subject),
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    action:
      "Inspect the retained GitHub Actions step log and model reliability report.",
  });
  await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`);
}

if (import.meta.main) await main();
