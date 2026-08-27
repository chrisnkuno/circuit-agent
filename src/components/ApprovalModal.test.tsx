/**
 * @vitest-environment happy-dom
 *
 * `bun test` gets its DOM from the `happydom.ts` preload in `bunfig.toml`; the repo-wide `vitest`
 * run has no such preload, so this file has to ask for one itself. Without it these tests fail with
 * `document is not defined` under the root suite — a failure about the harness, not the component,
 * and one that reads exactly like a real regression in CI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalModal } from "./ApprovalModal";

/**
 * The approval dialog, actually rendered and actually typed at.
 *
 * `approval.ts` proves which key maps to which decision. This proves the dialog is wired to it —
 * that the listener is attached, that the right callback fires, and above all that focus does not
 * land somewhere Enter would approve something. That last one cannot be checked by testing the
 * pure helper, and it is the only bug in this component that would actually matter.
 */

afterEach(cleanup);

const approval = { requestId: "r1", toolName: "write_file", summary: "write src/app.ts" };

describe("the approval dialog", () => {
  it("names the tool and what it wants to do", () => {
    render(<ApprovalModal approval={approval} onRespond={() => {}} />);
    expect(screen.getByText(/write src\/app\.ts/)).toBeTruthy();
  });

  it("offers all four decisions", () => {
    render(<ApprovalModal approval={approval} onRespond={() => {}} />);
    // Anchored: an unanchored /Deny/ also matches "Always deny", and getByRole throws on two hits.
    for (const label of ["Allow once", "Deny", "Always allow", "Always deny"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`, "i") }), label).toBeTruthy();
    }
  });

  it("reports the decision the clicked button stands for", () => {
    const onRespond = vi.fn();
    render(<ApprovalModal approval={approval} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /^Allow once/i }));
    expect(onRespond).toHaveBeenCalledWith("allow");
  });

  it("answers the keyboard shortcuts, so the dialog is usable without the mouse", () => {
    const onRespond = vi.fn();
    render(<ApprovalModal approval={approval} onRespond={onRespond} />);
    fireEvent.keyDown(window, { key: "y" });
    expect(onRespond).toHaveBeenCalledWith("allow");
    fireEvent.keyDown(window, { key: "n" });
    expect(onRespond).toHaveBeenCalledWith("deny");
  });

  it("does not put focus on a button — Enter must never approve by reflex", () => {
    // The one failure mode that actually costs something: people press Enter to dismiss dialogs.
    // If focus landed on "Allow once", a reflex would grant a file write.
    render(<ApprovalModal approval={approval} onRespond={() => {}} />);
    const active = document.activeElement;
    expect(active?.tagName).not.toBe("BUTTON");
    expect(active?.getAttribute("role")).toBe("alertdialog");
  });

  it("stops listening once it unmounts, so a stale dialog cannot answer for a new one", () => {
    const onRespond = vi.fn();
    const view = render(<ApprovalModal approval={approval} onRespond={onRespond} />);
    view.unmount();
    fireEvent.keyDown(window, { key: "y" });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("moves focus back to the dialog when a second request replaces the first", () => {
    const view = render(<ApprovalModal approval={approval} onRespond={() => {}} />);
    (document.querySelector("button") as HTMLButtonElement | null)?.focus();
    view.rerender(<ApprovalModal approval={{ ...approval, requestId: "r2" }} onRespond={() => {}} />);
    expect(document.activeElement?.getAttribute("role")).toBe("alertdialog");
  });

  it("shows the exact proposed file replacement before a decision", () => {
    render(<ApprovalModal approval={{
      ...approval,
      toolName: "edit_file",
      preview: { toolName: "edit_file", path: "src/app.ts", oldText: "const value = 1", newText: "const value = 2" },
    }} onRespond={() => {}} />);
    expect(screen.getByRole("heading", { name: "Exact proposed change" })).toBeTruthy();
    const change = screen.getByText(/@@ proposed replacement @@/).textContent ?? "";
    expect(change).toContain("-const value = 1");
    expect(change).toContain("+const value = 2");
  });

  it("states why the core classified an action as sensitive", () => {
    render(<ApprovalModal approval={{
      ...approval,
      safety: { sensitive: true, categories: ["credential"], reasons: ["writes a credential file"] },
    }} onRespond={() => {}} />);
    expect(screen.getByText("Sensitive action")).toBeTruthy();
    expect(screen.getByText("writes a credential file")).toBeTruthy();
  });
});
