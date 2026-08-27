/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActivityPanel } from "./ActivityPanel";
import type { ActivityEntry } from "../lib/chat-state";

afterEach(cleanup);

const entry = (patch: Partial<ActivityEntry> & { id: string }): ActivityEntry => ({
  name: "read_file",
  status: "ok",
  ...patch,
});

describe("the activity panel", () => {
  it("lists what the agent did, in order", () => {
    const { container } = render(
      <ActivityPanel busy={false} entries={[entry({ id: "1" }), entry({ id: "2", name: "run_command" })]} />,
    );
    const names = [...container.querySelectorAll(".activity-name")].map((node) => node.textContent);
    expect(names).toEqual(["read_file", "run_command"]);
  });

  it("says what state a call is in, in words as well as colour", () => {
    render(<ActivityPanel busy progress="Running tests…" entries={[entry({ id: "1", status: "running" })]} />);
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Running tests");
  });

  it("keeps successful output available without expanding it into the transcript", () => {
    const { container } = render(
      <ActivityPanel busy={false} entries={[
        entry({ id: "1", status: "failed", preview: "exit 1" }),
        entry({ id: "2", status: "ok", preview: "exit 0" }),
      ]} />,
    );
    const previews = [...container.querySelectorAll(".activity-preview")].map((node) => node.textContent);
    expect(previews).toEqual(["exit 1", "exit 0"]);
    const details = [...container.querySelectorAll("details")];
    expect(details[0].hasAttribute("open")).toBe(true);
    expect(details[1].hasAttribute("open")).toBe(false);
  });

  it("explains itself before anything has run", () => {
    render(<ActivityPanel busy={false} entries={[]} />);
    expect(screen.getByText(/Tools Nova runs/)).toBeTruthy();
  });

  it("survives a tab whose state predates it rather than taking the window down", () => {
    // Exactly what a hot reload — and, later, a restored session — can hand this component.
    const { container } = render(<ActivityPanel busy={false} />);
    expect(container.querySelector(".panel")).toBeTruthy();
  });
});
