import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The user's home directory, preferring `$HOME`/`$USERPROFILE` over `os.homedir()`.
 *
 * `os.homedir()` resolves the OS user database once and, at least under Bun, does not track a
 * `process.env.HOME` set later in the same process — so a test (or a wrapper script) that
 * redirects `HOME` to sandbox this file's I/O would silently keep hitting the real one. Reading
 * the environment variable directly is both more predictable and what actually makes that
 * override work; `os.homedir()` stays only as the fallback for the rare case neither is set.
 */
function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Where Nova remembers a pasted API key across sessions and projects.
 *
 * One file in the user's home directory, not the project: a key belongs to the person running
 * Nova, not to whichever repository happens to be open right now, and a project-local file risks
 * being committed by someone whose own `.gitignore` does not already know to exclude it. Written
 * with owner-only permissions, the same posture `~/.netrc` and `~/.aws/credentials` take.
 */
export function credentialsPath(home: string = defaultHome()): string {
  return path.join(home, ".nova", "credentials.json");
}

/** Every variable Nova has previously saved. A missing or corrupt file just means "none yet". */
export async function loadCredentials(home: string = defaultHome()): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await fs.readFile(credentialsPath(home), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    // A hand-edited or truncated file should not block every future startup — worst case, Nova
    // asks to set the key again, which is recoverable; refusing to start is not.
    return {};
  }
}

/** Saves one variable, merged with whatever else is already saved rather than replacing the file. */
export async function saveCredential(name: string, value: string, home: string = defaultHome()): Promise<void> {
  const file = credentialsPath(home);
  const existing = await loadCredentials(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...existing, [name]: value }, null, 2)}\n`, { mode: 0o600 });
}
