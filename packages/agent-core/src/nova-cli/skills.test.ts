import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { discoverSkillManifests, parseSkillManifest, SkillToolProvider, substitutePlaceholders } from "./skills";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-skills-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const validSchema = { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"], additionalProperties: false as const };

describe("parseSkillManifest", () => {
  it("parses a well-formed manifest", () => {
    const manifest = parseSkillManifest("skill.json", JSON.stringify({ name: "greet", description: "Greets someone", command: "echo hi", inputSchema: validSchema }));
    expect(manifest).toMatchObject({ name: "greet", description: "Greets someone", command: "echo hi" });
  });

  it("names the exact bad file in every failure mode, rather than a generic error", () => {
    expect(() => parseSkillManifest("bad/skill.json", "not json")).toThrow(/bad\/skill\.json.*invalid JSON/s);
    expect(() => parseSkillManifest("bad/skill.json", "[]")).toThrow(/bad\/skill\.json.*must be a JSON object/s);
    expect(() => parseSkillManifest("bad/skill.json", JSON.stringify({ description: "d", command: "c", inputSchema: validSchema }))).toThrow(/"name"/);
    expect(() => parseSkillManifest("bad/skill.json", JSON.stringify({ name: "n", command: "c", inputSchema: validSchema }))).toThrow(/"description"/);
    expect(() => parseSkillManifest("bad/skill.json", JSON.stringify({ name: "n", description: "d", inputSchema: validSchema }))).toThrow(/"command"/);
    expect(() => parseSkillManifest("bad/skill.json", JSON.stringify({ name: "n", description: "d", command: "c", inputSchema: { type: "object", properties: { x: { type: "object" } } } }))).toThrow();
  });

  it("rejects a non-integer or non-positive timeoutMs", () => {
    const base = { name: "n", description: "d", command: "c", inputSchema: validSchema };
    expect(() => parseSkillManifest("s.json", JSON.stringify({ ...base, timeoutMs: 1.5 }))).toThrow(/timeoutMs/);
    expect(() => parseSkillManifest("s.json", JSON.stringify({ ...base, timeoutMs: 0 }))).toThrow(/timeoutMs/);
    expect(() => parseSkillManifest("s.json", JSON.stringify({ ...base, timeoutMs: "60" }))).toThrow(/timeoutMs/);
  });
});

describe("substitutePlaceholders", () => {
  it("fills a placeholder with its single-quoted, escaped argument", () => {
    expect(substitutePlaceholders("echo {{text}}", { text: "hello" })).toBe("echo 'hello'");
  });

  it("neutralizes shell metacharacters instead of letting them terminate the quoted string", () => {
    // The classic injection: an argument that tries to close the quote and start a new command.
    const malicious = "'; rm -rf / #";
    const substituted = substitutePlaceholders("echo {{text}}", { text: malicious });
    // The escaped quoting must produce a single shell-safe token, not `'; rm -rf / #'` where the
    // first `'` closes the original quote early.
    expect(substituted).toBe(`echo '${malicious.replace(/'/g, "'\\''")}'`);
    expect(substituted).not.toMatch(/echo '';/);
  });

  it("joins an array argument's elements, each quoted", () => {
    expect(substitutePlaceholders("touch {{files}}", { files: ["a.txt", "b.txt"] })).toBe("touch 'a.txt' 'b.txt'");
  });

  it("throws when the command references a placeholder that was never provided", () => {
    expect(() => substitutePlaceholders("echo {{missing}}", {})).toThrow(/missing/);
  });

  describe("on Windows, where cmd.exe does not understand POSIX quoting at all", () => {
    it("uses double quotes, because a single quote is not a quote character to cmd", () => {
      // POSIX quoting here would not merely fail to protect the argument — cmd would pass the
      // quote marks through literally and leave anything inside them live.
      expect(substitutePlaceholders("echo {{text}}", { text: "hello world" }, "win32")).toBe('echo "hello world"');
    });

    it("escapes an embedded double quote by doubling it, cmd's own convention", () => {
      expect(substitutePlaceholders("echo {{text}}", { text: 'say "hi"' }, "win32")).toBe('echo "say ""hi"""');
    });

    it("defuses % so cmd cannot expand a variable the caller never wrote", () => {
      expect(substitutePlaceholders("echo {{text}}", { text: "100%PATH%" }, "win32")).toBe('echo "100%%PATH%%"');
    });

    it("contains an injection attempt inside the quoted argument rather than letting it chain", () => {
      const malicious = 'x" & del /q C:\\ & echo "';
      const substituted = substitutePlaceholders("echo {{text}}", { text: malicious }, "win32");
      // Every quote the attacker supplied is doubled, so none of them closes the argument early
      // and the `&` never reaches cmd as a command separator.
      expect(substituted).toBe('echo "x"" & del /q C:\\ & echo """');
      expect(substituted.startsWith('echo "')).toBe(true);
      expect(substituted.endsWith('"')).toBe(true);
    });

    it("still quotes POSIX-style for a sandbox, which runs Linux whatever the host is", () => {
      expect(substitutePlaceholders("echo {{text}}", { text: "hello world" }, "linux")).toBe("echo 'hello world'");
    });
  });
});

describe("discoverSkillManifests", () => {
  it("finds every skill.json under .nova/skills and reports a missing directory as zero skills", async () => {
    expect(await discoverSkillManifests(new LocalWorkspace(root))).toEqual([]);

    await fs.mkdir(path.join(root, ".nova/skills/greet"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/skills/greet/skill.json"), JSON.stringify({ name: "greet", description: "d", command: "echo hi", inputSchema: validSchema }));
    await fs.mkdir(path.join(root, ".nova/skills/count"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/skills/count/skill.json"), JSON.stringify({ name: "count", description: "d2", command: "echo 1", inputSchema: validSchema }));

    const manifests = await discoverSkillManifests(new LocalWorkspace(root));
    expect(manifests.map((manifest) => manifest.name).sort()).toEqual(["count", "greet"]);
  });

  it("reports a parse failure for one bad manifest rather than silently skipping it", async () => {
    await fs.mkdir(path.join(root, ".nova/skills/broken"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/skills/broken/skill.json"), "not json");
    await expect(discoverSkillManifests(new LocalWorkspace(root))).rejects.toThrow(/broken\/skill\.json/);
  });
});

describe("SkillToolProvider", () => {
  it("executes a skill's command through the workspace and reports real stdout/exit code", async () => {
    await fs.mkdir(path.join(root, ".nova/skills/greet"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".nova/skills/greet/skill.json"),
      JSON.stringify({ name: "greet", description: "Greets someone by name.", command: "printf 'hello %s' {{name}}", inputSchema: validSchema }),
    );
    const provider = new SkillToolProvider("local-skills", ".nova/skills", new LocalWorkspace(root));
    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    const result = await tools[0].invoke({ name: "world" });
    expect(result).toEqual({ content: "exit 0\nhello world", isError: false });
  });

  it("rejects arguments the skill's own schema does not accept, before the command ever runs", async () => {
    await fs.mkdir(path.join(root, ".nova/skills/greet"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".nova/skills/greet/skill.json"),
      JSON.stringify({ name: "greet", description: "d", command: "printf 'hello %s' {{name}}", inputSchema: validSchema }),
    );
    const provider = new SkillToolProvider("local-skills", ".nova/skills", new LocalWorkspace(root));
    const [tool] = await provider.listTools();
    await expect(tool.invoke({})).rejects.toThrow(/requires name/);
  });
});
