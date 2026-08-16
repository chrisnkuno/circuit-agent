import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(prompt).toContain("Test by invariant");
    expect(prompt).toContain("round-trips");
    expect(prompt).toContain("idempotence");
    expect(prompt).toContain("passing typecheck or build is not a test");
    // A change to existing behaviour needs a test that distinguishes old from new.
    expect(prompt).toContain("fails for the old behaviour");
  });

  it("states the exact behavioural boundary for each mode", () => {
    expect(buildNovaSystemPrompt(context, "plan", [])).toContain("cannot write files or run commands");
    expect(buildNovaSystemPrompt(context, "build", [])).toContain("approved by the user before it runs");
    expect(buildNovaSystemPrompt(context, "auto", [])).toContain("run without individual approval");
    expect(buildNovaSystemPrompt(context, "defender", [])).toContain("every effectful call is approved by the user");
  });

  it("appends the security playbooks only in defender mode, not the others", () => {
    const defenderPrompt = buildNovaSystemPrompt(context, "defender", []);
    expect(defenderPrompt).toContain("## Injection");
    expect(defenderPrompt).toContain("## Secrets & credential hygiene");
    expect(defenderPrompt).toContain("## Input validation, fuzzing & invariant-based testing");
    expect(defenderPrompt).toContain("## Logging, monitoring & deterrence");
    // The 2025 OWASP-aligned additions: security misconfiguration (now OWASP's #2 risk), supply
    // chain/CI integrity, client-side security, API security, SSRF, exceptional-condition handling,
    // business logic, and LLM/AI application security.
    expect(defenderPrompt).toContain("## Security misconfiguration");
    expect(defenderPrompt).toContain("## Software supply chain & CI/CD integrity");
    expect(defenderPrompt).toContain("## Client-side & browser security");
    expect(defenderPrompt).toContain("## API security");
    expect(defenderPrompt).toContain("## Server-side request forgery (SSRF)");
    expect(defenderPrompt).toContain("## Mishandling of exceptional conditions");
    expect(defenderPrompt).toContain("## Business logic & race conditions");
    expect(defenderPrompt).toContain("## LLM & AI application security");
    expect(defenderPrompt).toContain("## Threat intelligence & memory");
    expect(defenderPrompt).toContain("## Hardening resources, cost & hosting guidance");
    expect(buildNovaSystemPrompt(context, "build", [])).not.toContain("## Injection");
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
