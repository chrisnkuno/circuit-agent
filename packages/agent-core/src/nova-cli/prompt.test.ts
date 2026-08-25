import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentReport } from "./environment";
import { DEFENDER_PLAYBOOK_CATALOG, playbookFor } from "./defender-playbooks";
import { buildNovaSystemPrompt, collectProjectContext } from "./prompt";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-prompt-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectProjectContext", () => {
  it("finds an instructions file and prefers NOVA.md when several exist", async () => {
    await fs.writeFile(path.join(root, "NOVA.md"), "Use tabs.");
    await fs.writeFile(path.join(root, "AGENTS.md"), "Use spaces.");
    const context = await collectProjectContext(root);
    expect(context.instructionsFile).toBe("NOVA.md");
    expect(context.instructions).toBe("Use tabs.");
  });

  it("falls back through the list when the preferred files are absent", async () => {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Be terse.");
    const context = await collectProjectContext(root);
    expect(context.instructionsFile).toBe("CLAUDE.md");
  });

  it("leaves instructions null rather than erroring when no such file exists", async () => {
    const context = await collectProjectContext(root);
    expect(context.instructions).toBeNull();
    expect(context.instructionsFile).toBeNull();
  });

  it("truncates an oversized instructions file rather than sending it whole", async () => {
    await fs.writeFile(path.join(root, "NOVA.md"), "x".repeat(100));
    const context = await collectProjectContext(root, 10);
    expect(context.instructions).toHaveLength(10);
  });

  it("loads instruction files from repository root to a nested working directory with provenance", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, "AGENTS.md"), "Repository rule.");
    const nested = path.join(root, "packages", "cli");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "AGENTS.override.md"), "CLI-specific rule.");

    const context = await collectProjectContext(nested);
    expect(context.instructionsFile).toBe("AGENTS.md -> packages/cli/AGENTS.override.md");
    expect(context.instructions).toContain("Repository rule.");
    expect(context.instructions).toContain("CLI-specific rule.");
    expect(context.instructionSources).toHaveLength(2);
    expect(context.instructionSources?.every((source) => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true);
  });

  it("leaves generated directories out of the layout, so a build cannot rewrite the prompt", async () => {
    // These appear and disappear as tests and builds run. In the listing they are noise the tools
    // cannot even search; in the *cached prefix* they are a cache write bought by running a test.
    await fs.mkdir(path.join(root, "src"));
    for (const generated of ["node_modules", "dist", "coverage", "test-results", "tmp", "target"]) {
      await fs.mkdir(path.join(root, generated));
    }
    const context = await collectProjectContext(root);
    expect(context.layout).toEqual(["src/"]);
  });

  it("lists the top-level layout, hiding dotfiles except .github", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, ".github"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, "README.md"), "");
    const context = await collectProjectContext(root);
    expect(context.layout).toEqual([".github/", "README.md", "src/"]);
  });

  it("degrades to an empty layout rather than failing when the root cannot be listed", async () => {
    const context = await collectProjectContext(path.join(root, "does-not-exist"));
    expect(context.layout).toEqual([]);
  });

  it("reads package.json scripts when the project has one", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }));
    const context = await collectProjectContext(root);
    expect(context.packageScripts).toEqual(["test", "build"]);
  });

  it("leaves scripts empty for a non-Node project rather than erroring", async () => {
    const context = await collectProjectContext(root);
    expect(context.packageScripts).toEqual([]);
  });

  it("leaves scripts empty when package.json exists but is not valid JSON", async () => {
    await fs.writeFile(path.join(root, "package.json"), "{ not json");
    const context = await collectProjectContext(root);
    expect(context.packageScripts).toEqual([]);
  });

  it("reads the current git branch from a real checkout", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/nova-cli-packages\n");
    const context = await collectProjectContext(root);
    expect(context.gitBranch).toBe("nova-cli-packages");
  });

  it("leaves the branch null outside a git checkout", async () => {
    const context = await collectProjectContext(root);
    expect(context.gitBranch).toBeNull();
  });
});

describe("buildNovaSystemPrompt", () => {
  const context = { root: "/repo", instructions: null, instructionsFile: null, layout: [], packageScripts: [], gitBranch: null };

  it("tells the model plainly when it is working on the user's real machine", () => {
    const prompt = buildNovaSystemPrompt(context, "build", ["read_file"]);
    expect(prompt).toContain("real project on the user's machine");
    expect(prompt).not.toContain("isolated remote sandbox");
  });

  it("tells the model plainly when it is working in a disposable remote sandbox instead", () => {
    const workspace = { kind: "e2b" as const, label: "sandbox:abc123" };
    const prompt = buildNovaSystemPrompt(context, "build", ["read_file"], workspace as never);
    expect(prompt).toContain("isolated remote sandbox");
    expect(prompt).toContain("Workspace (e2b): sandbox:abc123");
    expect(prompt).not.toContain("Project root:");
  });

  it("asks for invariant-based tests rather than a single happy-path example", () => {
    // The failure this targets is an agent that writes one assertion for the value it just
    // produced. Naming the properties — and saying plainly that a build is not a test — is what
    // makes the difference between a suite that pins behaviour and one that pins a coincidence.
    const prompt = buildNovaSystemPrompt(context, "build", ["run_command"]);
    expect(prompt).toContain("INVARIANT");
    expect(prompt).toContain("round-trips");
    expect(prompt).toContain("idempotence");
    expect(prompt).toContain("passing typecheck or build is not a test");
    // A change to existing behaviour needs a test that distinguishes old from new.
    expect(prompt).toContain("fails for the old behaviour");
  });

  it("requires verified managed previews instead of trusting server startup text", () => {
    const prompt = buildNovaSystemPrompt(context, "build", ["run_command", "start_application", "application_status"]);
    expect(prompt).toContain("use start_application with its actual port");
    expect(prompt).toContain("Startup log text is not proof");
    expect(prompt).toContain("Report it as running only after that tool verifies HTTP reachability");
  });

  /**
   * Invariants alone let an agent ship a component whose every property holds and which was never
   * mounted. The prompt has to name all three levels, and has to say the third is not optional.
   */
  it("asks for behavioural and functional levels on top of the invariants", () => {
    const prompt = buildNovaSystemPrompt(context, "build", ["run_command"]);
    expect(prompt).toContain("BEHAVIOURAL");
    expect(prompt).toContain("FUNCTIONAL");
    // The concrete ways to get functional evidence, so this is a recipe rather than an exhortation.
    expect(prompt).toContain("Render the entry point");
    expect(prompt).toContain("exit code");
    // Named failure modes, which is what makes level 3 land as necessary rather than ceremonial.
    expect(prompt).toContain("never mounted");
  });

  /**
   * A slow suite gets skipped, and a skipped suite proves nothing — so the speed constraint is part
   * of the testing doctrine itself, not a separate piece of advice.
   */
  it("bounds the cost of the suite it just asked for", () => {
    const prompt = buildNovaSystemPrompt(context, "build", ["run_command"]);
    expect(prompt).toContain("seconds, not minutes");
    expect(prompt).toContain("rather than spawning a browser");
  });

  it("tells the agent to batch its tool calls, which is the largest single cost in a turn", () => {
    // Measured: 90% of model turns in real sessions emitted exactly one tool call, and todo_write
    // alone accounted for 47 whole round trips.
    const prompt = buildNovaSystemPrompt(context, "build", ["run_command", "todo_write"]);
    expect(prompt).toContain("Put every tool call you can into the same turn");
    expect(prompt).toContain("Never spend a whole turn on todo_write alone");
  });

  it("states the exact behavioural boundary for each mode", () => {
    expect(buildNovaSystemPrompt(context, "plan", [])).toContain("cannot write files or run commands");
    expect(buildNovaSystemPrompt(context, "build", [])).toContain("approved by the user before it runs");
    expect(buildNovaSystemPrompt(context, "auto", [])).toContain("run without individual approval");
    expect(buildNovaSystemPrompt(context, "defender", [])).toContain("every effectful call is approved by the user");
  });

  it("permits contained credential workflows without permitting disclosure", () => {
    const prompt = buildNovaSystemPrompt(context, "auto", ["read_file", "write_file"]);
    expect(prompt).toContain("Do not refuse ordinary, authorized development work merely because it involves a credential");
    expect(prompt).toContain("read a project-local .env file");
    expect(prompt).toContain("secret pasted into chat is explicit authorization");
    expect(prompt).toContain("Never send, upload, publish, or paste a secret to an external destination");
  });

  it("indexes every security playbook in defender mode, and none of them anywhere else", () => {
    const defenderPrompt = buildNovaSystemPrompt(context, "defender", ["query_defensive_brain", "read_playbook"]);
    // The index, not the text: every category is reachable by id, and the full 44,000 characters
    // are one read_playbook call away instead of being on every request of every iteration.
    for (const entry of DEFENDER_PLAYBOOK_CATALOG) {
      expect(defenderPrompt, entry.id).toContain(entry.id);
      expect(defenderPrompt, entry.title).toContain(entry.title);
    }
    expect(defenderPrompt).toContain("read_playbook");
    expect(defenderPrompt).toContain("query_defensive_brain");
    expect(defenderPrompt).toContain("DEFENDER mode");

    // The bodies stay out. This is the whole saving, so it is asserted rather than assumed.
    const injection = DEFENDER_PLAYBOOK_CATALOG.find((entry) => entry.id === "injection")!;
    expect(defenderPrompt).not.toContain(injection.text.split("\n")[2]);
    expect(defenderPrompt.length).toBeLessThan(20_000);

    const buildPrompt = buildNovaSystemPrompt(context, "build", []);
    expect(buildPrompt).not.toContain("read_playbook");
    expect(buildPrompt).not.toContain("query_defensive_brain");
    expect(buildPrompt).not.toContain("access-control");
  });

  it("keeps every indexed playbook retrievable by the id it advertises", () => {
    // An index entry the tool cannot resolve is worse than no index: the model spends a call
    // finding out. Round-trip every id the prompt offers.
    for (const entry of DEFENDER_PLAYBOOK_CATALOG) {
      expect(playbookFor(entry.id)?.text, entry.id).toBe(entry.text);
    }
    expect(playbookFor("no-such-playbook")).toBeUndefined();
  });

  it("includes project signals only when they exist, rather than printing empty labels", () => {
    const bare = buildNovaSystemPrompt(context, "build", []);
    expect(bare).not.toContain("Git branch:");
    expect(bare).not.toContain("Top level:");
    expect(bare).not.toContain("package.json scripts:");

    const rich = buildNovaSystemPrompt({
      root: "/repo", instructions: null, instructionsFile: null,
      layout: ["src/", "README.md"], packageScripts: ["test"], gitBranch: "main",
    }, "build", []);
    expect(rich).toContain("Git branch: main");
    expect(rich).toContain("Top level: src/ README.md");
    expect(rich).toContain("package.json scripts: test");
  });

  it("names the maintainers' file and puts their instructions ahead of Nova's own habits", () => {
    const prompt = buildNovaSystemPrompt(
      { root: "/repo", instructions: "Always use tabs.", instructionsFile: "NOVA.md", layout: [], packageScripts: [], gitBranch: null },
      "build", [],
    );
    expect(prompt).toContain("Project instructions from NOVA.md");
    expect(prompt).toContain("Always use tabs.");
  });

  it("lists the tools actually offered, which changes with mode", () => {
    const prompt = buildNovaSystemPrompt(context, "plan", ["read_file", "grep_files"]);
    expect(prompt).toContain("Available tools: read_file, grep_files.");
  });
});

describe("the environment section", () => {
  const report: EnvironmentReport = {
    backend: "local",
    platform: "linux",
    host: "Linux 6.18 x64 on linux",
    execution: "Runs in a real shell, so pipes and redirection work.",
    packageManager: { name: "bun", lockfile: "bun.lock" },
    available: [{ name: "bun", version: "1.3.14" }, { name: "git", version: "2.43.0" }],
    missing: ["npm", "pnpm"],
  };

  it("puts what is installed in front of the model before it writes a command", async () => {
    const prompt = buildNovaSystemPrompt(await collectProjectContext(root), "build", ["run_command"], undefined, report);
    expect(prompt).toContain("bun 1.3.14");
    expect(prompt).toContain("NOT available");
    expect(prompt).toContain("npm");
  });

  it("is absent, rather than guessed at, when nothing was probed", async () => {
    const prompt = buildNovaSystemPrompt(await collectProjectContext(root), "build", ["run_command"]);
    expect(prompt).not.toContain("NOT available");
    expect(prompt).not.toContain("Environment (measured");
  });
});
