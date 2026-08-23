import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const html = readFileSync(path.join(root, "index.html"), "utf8");
const script = readFileSync(path.join(root, "app.js"), "utf8");
const styles = readFileSync(path.join(root, "styles.css"), "utf8");
const readme = readFileSync(path.join(root, "..", "..", "README.md"), "utf8");
const publisher = readFileSync(
  path.join(root, "..", "..", "scripts", "reliability-publish.ts"),
  "utf8",
);

describe("the public reliability observatory", () => {
  it("has every DOM target used by the script", () => {
    const ids = [...script.matchAll(/\$\("([a-z-]+)"\)/g)].map(
      (match) => match[1],
    );
    for (const id of new Set(ids)) expect(html).toContain(`id="${id}"`);
  });

  it("publishes the metrics operators need rather than only a vanity score", () => {
    for (const label of [
      "TASK COMPLETION",
      "OUTPUT QUALITY",
      "TOOL FAILURE RATE",
      "PROVIDER FAILURE RATE",
      "MEDIAN LATENCY",
      "CONTROL TESTS",
      "OS COVERAGE",
      "TOTAL TOKENS",
      "PREDICTION COVERAGE",
      "LOGGED RUN ERRORS",
    ]) {
      expect(script).toContain(label);
    }
    for (const control of [
      "ui",
      "memoryResume",
      "security",
      "approvals",
      "costAccuracy",
      "portability",
    ]) {
      expect(script).toContain(`"${control}"`);
    }
  });

  it("renders the dynamically rescored or promoted current report", () => {
    expect(script).toContain("const latest = data.current || best");
    expect(script).not.toContain('report.model === "circuit-2-turbo"');
  });

  it("keeps controls and metrics reachable on narrow screens", () => {
    expect(styles).toMatch(/@media\s*\(max-width:\s*520px\)/);
    expect(styles).toMatch(
      /\.run-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    );
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  it("shows recorded outputs without granting framed builds same-origin access", () => {
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(script).toContain('value.startsWith("runs/latest/")');
    expect(script).toContain("text.textContent = await response.text()");
    expect(script).not.toContain('artifact-text").innerHTML');
    expect(html).toContain("does not run an agent or contain API keys");
  });

  it("never embeds provider credentials in the public bundle", () => {
    expect(`${html}\n${script}\n${styles}`).not.toMatch(
      /sk-or-v1-|CIRCUITNOTION_API_KEY|OPENROUTER_API_KEY/,
    );
  });

  it("gives the README a dynamic score badge and GitHub-native evidence graph", () => {
    expect(readme).toContain("img.shields.io/endpoint");
    expect(readme).toContain("```mermaid");
    expect(publisher).toContain('"badge.json"');
    expect(publisher).toContain("message: `${score}/100`");
  });
});
