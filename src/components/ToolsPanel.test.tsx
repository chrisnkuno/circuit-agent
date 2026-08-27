/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const getTools = vi.fn();
vi.mock("../lib/ipc", () => ({ getTools: (...args: unknown[]) => getTools(...args) }));
const { ToolsPanel } = await import("./ToolsPanel");

afterEach(cleanup);
beforeEach(() => {
  getTools.mockReset();
  getTools.mockResolvedValue({
    tools: [
      { name: "read_file", description: "Read a file", effect: "none", requiresApproval: false, provenance: { kind: "built-in" } },
      { name: "deploy", description: "Deploy the app", effect: "external", requiresApproval: true, provenance: { kind: "mcp", providerId: "production" } },
    ],
    hooks: { preToolUse: ["check.sh"], postToolUse: [] },
    providerIds: ["production"],
  });
});

describe("the tool inspector", () => {
  it("shows the exact session tools with provenance and approval posture", async () => {
    render(<ToolsPanel open onClose={() => {}} tabId="tab_9" />);
    expect(await screen.findByText("deploy")).toBeTruthy();
    expect(screen.getByText(/mcp · production/)).toBeTruthy();
    expect(screen.getByText(/external · approval/)).toBeTruthy();
    expect(getTools).toHaveBeenCalledWith("tab_9");
  });

  it("filters by extension provenance as well as tool name", async () => {
    render(<ToolsPanel open onClose={() => {}} tabId="tab_9" />);
    await screen.findByText("deploy");
    fireEvent.change(screen.getByLabelText("Filter tools"), { target: { value: "production" } });
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.getByText("deploy")).toBeTruthy();
  });
});
