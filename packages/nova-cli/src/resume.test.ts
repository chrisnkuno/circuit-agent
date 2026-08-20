import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSession, type SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { startAnthropicStub, type AnthropicStub } from "./pty/anthropic-stub";
import { readSessionModelTurns } from "./resumed-spend";

/**
 * Resuming a past session, end to end, through the real binary.
 *
 * The unit tests around this cover the pieces — `parseArgs` reads `--resume`, `loadSession`
 * validates a record, `NovaAgent.resume` restores a transcript — and every one of them can pass
 * while the thing a user asked for does not happen. Resuming is a claim about a *second process*:
 * that it finds the right session on disk, sends the earlier conversation to the model, and keeps
 * writing into the same record instead of quietly starting a new one beside it. None of that is
 * observable from inside one process, so these tests run the CLI twice against a local stub of the
 * Anthropic API and read both what the model was sent and what landed on disk.
 *
 * One-shot mode (`nova --resume "…"`) rather than the REPL, deliberately: it exercises the same
 * resume path without needing a pseudo-terminal, so the assertions here are about resuming rather
 * than about terminal behaviour, which `src/pty/` already owns.
 */

const NOVA_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "nova.ts");

type RunResult = { code: number | null; stdout: string; stderr: string };

describe("resuming a past session", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "nova-resume-"));
    // Isolated from the developer's own settings, which could otherwise supply a real API key.
    configDir = await mkdtemp(path.join(os.tmpdir(), "nova-resume-config-"));
  });

  afterEach(async () => {
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bun", ["run", NOVA_ENTRY, "--currency", "USD", ...args], {
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-test-fake",
          ANTHROPIC_BASE_URL: stub.url,
          NOVA_CONFIG_DIR: configDir,
          // A fixed currency and no FX lookups: either one left to the host would make the run
          // depend on a network the suite may not have.
          NOVA_FX_OFFLINE: "true",
          TZ: "UTC",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function sessionIds(): Promise<string[]> {
    const files = await readdir(path.join(cwd, ".nova", "sessions")).catch(() => [] as string[]);
    return files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();
  }

  /** Flattens a recorded request's messages to plain text, whatever content shape they arrived in. */
  function textOf(request: { messages: Array<{ role: string; content: unknown }> }): string[] {
    return request.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
  }

  it("sends the earlier conversation to the model and keeps writing into the same record", async () => {
    stub.enqueue({ kind: "text", text: "Noted: the port is 8443." });
    const first = await run(["what port does the service listen on?"]);
    expect(first.code).toBe(0);

    const [created] = await sessionIds();
    expect(created).toBeDefined();

    stub.enqueue({ kind: "text", text: "You said 8443." });
    const second = await run(["--resume", "remind me?"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Resumed ${created}`);

    // The evidence that this resumed rather than merely printed the word: the second request
    // carried the first exchange, so the model could answer from it.
    const requests = stub.requests();
    expect(requests).toHaveLength(2);
    expect(textOf(requests[0])).toEqual(["what port does the service listen on?"]);
    const carried = textOf(requests[1]);
    expect(carried[0]).toContain("what port does the service listen on?");
    expect(carried.join("\n")).toContain("8443");
    expect(carried.at(-1)).toContain("remind me?");

    // And the second turn extended the record rather than opening a session next to it — a resume
    // that forks the history is worse than none, because the divergence is invisible.
    expect(await sessionIds()).toEqual([created]);
    const record = await loadSession(cwd, created) as SessionRecord;
    expect(record.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(record.revision).toBeGreaterThan(1);
  }, 180_000);

  it("resumes the most recently updated session when no id is given", async () => {
    stub.enqueue({ kind: "text", text: "first" });
    await run(["the older thread"]);
    stub.enqueue({ kind: "text", text: "second" });
    await run(["the newer thread"]);

    const records = (await Promise.all((await sessionIds()).map((id) => loadSession(cwd, id))))
      .filter((record): record is SessionRecord => record !== null);
    expect(records).toHaveLength(2);

    // Read off disk rather than assumed from the order the two runs were started. Which one is
    // "latest" is a fact about the records, and asserting it from the test's own narrative would
    // make this fail for the wrong reason on a loaded machine while proving nothing extra.
    const [newest, oldest] = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
    expect(newest.updatedAt).toBeGreaterThan(oldest.updatedAt);

    stub.enqueue({ kind: "text", text: "third" });
    const resumed = await run(["--resume", "carry on"]);
    expect(resumed.code).toBe(0);

    // "Latest" has to mean latest by when the session was last *worked on*. Whichever id sorts
    // last alphabetically is not that question, and the two only agree by coincidence.
    expect(resumed.stdout).toContain(`Resumed ${newest.id}`);
    const carried = textOf(stub.requests()[2]).join("\n");
    expect(carried).toContain(newest.title);
    expect(carried).not.toContain(oldest.title);
  }, 180_000);

  it("resumes a named session rather than the newest one", async () => {
    stub.enqueue({ kind: "text", text: "first" });
    await run(["the older thread"]);
    stub.enqueue({ kind: "text", text: "second" });
    await run(["the newer thread"]);

    const older = (await Promise.all((await sessionIds()).map((id) => loadSession(cwd, id))))
      .filter((record): record is SessionRecord => record !== null)
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];

    stub.enqueue({ kind: "text", text: "third" });
    const resumed = await run(["--resume", older.id, "carry on"]);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain(`Resumed ${older.id}`);
    expect(textOf(stub.requests()[2]).join("\n")).toContain("the older thread");
  }, 180_000);

  it("fails loudly on an id that names no session, instead of silently starting a new one", async () => {
    stub.enqueue({ kind: "text", text: "first" });
    await run(["the only thread"]);
    const before = await sessionIds();

    // A mistyped id looks exactly like a successful resume for the first few seconds and then
    // diverges in silence: the work lands in a new session while the user believes they are adding
    // to the old one. Refusing costs one retyped id; not refusing costs the thread.
    const missing = "20260101T000000Z-nosuch";
    const resumed = await run(["--resume", missing, "carry on"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toContain(`No session ${missing}`);
    expect(resumed.stderr).toContain("--sessions");

    // Nothing was created, and no model call was made on the way to failing.
    expect(await sessionIds()).toEqual(before);
    expect(stub.requestCount()).toBe(1);
  }, 180_000);

  it("starts a new session when there is nothing to resume, since no id was asked for", async () => {
    // `--resume` with no argument is "carry on with whatever I was doing". In a project with no
    // history that is not an error, it is a first session — the opposite of a named id.
    stub.enqueue({ kind: "text", text: "hello" });
    const resumed = await run(["--resume", "start something"]);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("starting a new one");
    expect(await sessionIds()).toHaveLength(1);
  }, 180_000);

  it("carries the session's earlier spend into the resumed run's reported cost", async () => {
    // A budget is approved for a session, but the ledger enforcing it is built per process. If a
    // resumed process starts that ledger at zero, `--budget $5` quietly means five dollars *per
    // resume*, and every cost the run reports is the cost of only its own share of the thread.
    //
    // The stub prices every turn identically — fixed input tokens, replies of equal length — so
    // the two runs below differ in exactly one thing: whether the second one knows what the first
    // one spent. Same number for both is the bug; roughly double is the fix.
    const costOf = (stdout: string): number => {
      const end = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; cost?: string | null })
        .find((record) => record.type === "turn_end");
      expect(end?.cost).toBeTruthy();
      return Number(end!.cost!.replace(/[^0-9.]/g, ""));
    };

    stub.enqueue({ kind: "text", text: "alpha" });
    const first = await run(["--json", "the opening request"]);
    expect(first.code).toBe(0);

    const [id] = await sessionIds();
    // Rebuilt from the journal's recorded token usage, not from the record's `totalRwf` — see
    // `resumed-spend.ts` for why that field is not a currency.
    expect(await readSessionModelTurns(cwd, id)).toHaveLength(1);

    stub.enqueue({ kind: "text", text: "bravo" });
    const resumed = await run(["--json", "--resume", "carry on"]);
    expect(resumed.code).toBe(0);

    const alone = costOf(first.stdout);
    const carried = costOf(resumed.stdout);
    expect(alone).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(alone);
  }, 180_000);

  it("refuses a session recorded against a different project root", async () => {
    stub.enqueue({ kind: "text", text: "first" });
    await run(["a thread in this project"]);
    const [id] = await sessionIds();

    // Session files are ordinary JSON in a directory that gets copied, committed and synced. A
    // record whose `root` is somebody else's checkout must not be replayed against this one: the
    // paths in its transcript refer to files that are not here.
    const file = path.join(cwd, ".nova", "sessions", `${id}.json`);
    const record = JSON.parse(await readFile(file, "utf8")) as SessionRecord;
    await writeFile(file, JSON.stringify({ ...record, root: path.join(os.tmpdir(), "somewhere-else") }, null, 2));

    const resumed = await run(["--resume", id, "carry on"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toContain(`No session ${id}`);
  }, 180_000);
});
