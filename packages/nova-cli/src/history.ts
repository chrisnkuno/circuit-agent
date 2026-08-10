import { promises as fs } from "node:fs";
import path from "node:path";
import { settingsDirectory } from "./settings";

const MAX_HISTORY = 200;
const SENSITIVE = /(?:api[_-]?key|authorization|password|secret|token)\s*[:=]/i;

function historyFile(environment: Record<string, string | undefined>): string {
  return path.join(settingsDirectory(environment), "history.json");
}

export function sanitizeHistory(lines: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "/settings" || SENSITIVE.test(line)) continue;
    const existing = result.indexOf(line);
    if (existing >= 0) result.splice(existing, 1);
    result.push(line);
  }
  return result.slice(-MAX_HISTORY);
}

export async function loadHistory(environment: Record<string, string | undefined>): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyFile(environment), "utf8"));
    return Array.isArray(parsed) ? sanitizeHistory(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

export async function saveHistory(lines: readonly string[], environment: Record<string, string | undefined>): Promise<void> {
  const file = historyFile(environment);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(sanitizeHistory(lines), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}
