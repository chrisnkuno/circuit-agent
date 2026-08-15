import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsPath, loadCredentials, saveCredential } from "./credentials";

async function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "nova-credentials-"));
}

describe("credentials", () => {
  it("has nothing saved yet when the file does not exist", async () => {
    const home = await tmpHome();
    try {
      expect(await loadCredentials(home)).toEqual({});
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("round-trips a saved key through the same home directory", async () => {
    const home = await tmpHome();
    try {
      await saveCredential("ANTHROPIC_API_KEY", "sk-ant-test", home);
      expect(await loadCredentials(home)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("merges a new key with what was already saved, rather than replacing the file", async () => {
    const home = await tmpHome();
    try {
      await saveCredential("ANTHROPIC_API_KEY", "sk-ant-1", home);
      await saveCredential("OPENAI_API_KEY", "sk-oai-1", home);
      expect(await loadCredentials(home)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-1", OPENAI_API_KEY: "sk-oai-1" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("overwrites just the one key being re-saved", async () => {
    const home = await tmpHome();
    try {
      await saveCredential("ANTHROPIC_API_KEY", "sk-ant-old", home);
      await saveCredential("ANTHROPIC_API_KEY", "sk-ant-new", home);
      expect(await loadCredentials(home)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-new" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("writes the file with owner-only permissions, since it holds a live secret", async () => {
    const home = await tmpHome();
    try {
      await saveCredential("ANTHROPIC_API_KEY", "sk-ant-test", home);
      const mode = (await fs.stat(credentialsPath(home))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt file instead of blocking startup", async () => {
    const home = await tmpHome();
    try {
      await fs.mkdir(path.dirname(credentialsPath(home)), { recursive: true });
      await fs.writeFile(credentialsPath(home), "{ not valid json");
      expect(await loadCredentials(home)).toEqual({});
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("ignores non-string values rather than handing a broken environment variable to a provider", async () => {
    const home = await tmpHome();
    try {
      await fs.mkdir(path.dirname(credentialsPath(home)), { recursive: true });
      await fs.writeFile(credentialsPath(home), JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-ok", SOME_FLAG: 42, OTHER: null }));
      expect(await loadCredentials(home)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-ok" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
