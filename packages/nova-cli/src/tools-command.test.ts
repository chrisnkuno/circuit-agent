import { describe, expect, it } from "vitest";
import { renderTools, type ToolsView } from "./tools-command";

const noHooks = { preToolUse: [], postToolUse: [] };

function view(overrides: Partial<ToolsView> = {}): ToolsView {
  return {
    tools: [{ name: "read_file", provenance: undefined }, { name: "write_file", provenance: { kind: "built-in" } }],
    hooks: noHooks,
    ...overrides,
  };
}

describe("renderTools", () => {
  it("groups built-in tools together, whether provenance is absent or explicitly built-in", () => {
    const output = renderTools(view());
    expect(output).toContain("built-in (2)");
    expect(output).toContain("read_file, write_file");
  });

  it("says plainly when nothing external is loaded, and how to add something", () => {
    const output = renderTools(view());
    expect(output).toContain("No skills, plugins or MCP servers loaded.");
    expect(output).toContain(".nova/skills");
  });

  it("lists each external source separately, so two servers are never conflated", () => {
    const output = renderTools(view({
      tools: [
        { name: "read_file", provenance: undefined },
        { name: "deploy", provenance: { kind: "mcp", providerId: "prod" } },
        { name: "rollback", provenance: { kind: "mcp", providerId: "prod" } },
        { name: "wordcount", provenance: { kind: "skill", providerId: "local-skills" } },
      ],
    }));
    expect(output).toContain("mcp:prod (2)");
    expect(output).toContain("deploy, rollback");
    expect(output).toContain("skill:local-skills (1)");
    expect(output).toContain("wordcount");
  });

  it("gives a project with no skills the friendly empty state, not a warning about the always-on reader", () => {
    // Regression: `/tools` on a fresh project reported `skill:local-skills (0) — loaded but
    // offering no tools`, because the top-level skills reader is always present whether or not the
    // directory is. Every new user was shown an anomaly notice for the ordinary state of having no
    // skills, and the helpful empty-state hint below could never appear.
    const output = renderTools(view({ emptyProviders: [] }));
    expect(output).toContain("No skills, plugins or MCP servers loaded.");
    expect(output).not.toContain("loaded but offering no tools");
    expect(output).not.toContain("local-skills");
  });

  it("shows a provider that loaded but offers nothing, rather than hiding it as if absent", () => {
    // Usually a wrong manifest path — indistinguishable from "not configured" unless it is shown.
    const output = renderTools(view({ emptyProviders: ["mcp:typo-server"] }));
    expect(output).toContain("mcp:typo-server");
    expect(output).toContain("loaded but offering no tools");
  });

  it("shows hooks and distinguishes the blocking phase from the advisory one", () => {
    const output = renderTools(view({
      hooks: { preToolUse: [".nova/hooks/pre-tool-use/deny.sh"], postToolUse: [".nova/hooks/post-tool-use/audit.sh"] },
    }));
    expect(output).toContain("deny.sh");
    expect(output).toContain("can block a tool call");
    expect(output).toContain("audit.sh");
    expect(output).toContain("can warn, cannot block");
  });

  it("omits the hooks section entirely when there are none, rather than printing an empty heading", () => {
    expect(renderTools(view())).not.toContain("hooks");
  });

  it("always states that external tools are approval-gated, since that is the safety property", () => {
    expect(renderTools(view())).toContain("requires approval on every call");
  });

  it("applies styling through the injected style, never hardcoding escape codes", () => {
    const output = renderTools(
      view({ tools: [{ name: "deploy", provenance: { kind: "mcp", providerId: "prod" } }] }),
      { bold: (t) => `<b>${t}</b>`, dim: (t) => `<d>${t}</d>`, cyan: (t) => `<c>${t}</c>`, yellow: (t) => `<y>${t}</y>` },
    );
    expect(output).toContain("<y>mcp:prod</y>");
    expect(output).toContain("<c>deploy</c>");
    expect(output).not.toContain("["); // no raw ANSI leaked in from anywhere
  });
});
