import { describe, expect, it } from "vitest";
import { validateSandboxCommand, validateWorkspaceFile } from "./sandbox-policy";

describe("sandbox policy", () => {
  it("allows bounded repository checks", () => {
    expect(() => validateSandboxCommand({ program: "bun", args: ["test"], cwd: "/workspace/repo", timeoutMs: 60_000 })).not.toThrow();
    expect(() => validateSandboxCommand({ program: "git", args: ["diff", "--stat"], cwd: "/workspace/repo", timeoutMs: 5_000 })).not.toThrow();
  });

  it("blocks inline evaluation and command-capable search flags", () => {
    expect(() => validateSandboxCommand({ program: "python", args: ["-c", "import os"], timeoutMs: 5_000 })).toThrow("blocked");
    expect(() => validateSandboxCommand({ program: "find", args: [".", "-exec", "sh", "{}", ";"], timeoutMs: 5_000 })).toThrow("blocked");
    expect(() => validateSandboxCommand({ program: "git", args: ["clone", "https://example.com/repo"], timeoutMs: 5_000 })).toThrow("read-only");
    expect(() => validateSandboxCommand({ program: "bun", args: ["x", "remote-package"], timeoutMs: 5_000 })).toThrow("declared script");
    expect(() => validateSandboxCommand({ program: "npm", args: ["install"], timeoutMs: 5_000 })).toThrow("declared script");
  });

  it("keeps commands and files inside the workspace", () => {
    expect(() => validateSandboxCommand({ program: "rg", args: ["needle"], cwd: "/tmp", timeoutMs: 5_000 })).toThrow("/workspace");
    expect(() => validateSandboxCommand({ program: "ls", args: ["/etc"], cwd: "/workspace/repo", timeoutMs: 5_000 })).toThrow("/workspace");
    expect(() => validateWorkspaceFile("/workspace/../secret", "no")).toThrow("/workspace");
    expect(() => validateWorkspaceFile("/workspace-escape/secret", "no")).toThrow("/workspace");
    expect(() => validateWorkspaceFile("/workspace/src/index.ts", "export {};")).not.toThrow();
    expect(() => validateWorkspaceFile("/workspace/large.bin", "x".repeat(1_000_001))).toThrow("1MB");
  });
});
