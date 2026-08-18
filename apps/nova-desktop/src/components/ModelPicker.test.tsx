/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";

/**
 * Switching model rebuilds the session underneath the conversation, so "how many times did the user
 * ask for it" is not a cosmetic question. The picker binds one key handler to the filter field and
 * another to the menu around it — the arrangement that lets arrows work from either — and a key
 * pressed in the field travels through both. Every test here is a statement that one keypress is
 * one switch.
 */

afterEach(cleanup);

function open(onPick = vi.fn()) {
  render(
    <ModelPicker
      provider="circuitnotion"
      model="gpt-5.6-luna"
      busy={false}
      onPick={onPick}
      open
      onOpenChange={() => {}}
    />,
  );
  return onPick;
}

describe("the model picker", () => {
  it("switches once for one Enter, not once per handler the key passes through", () => {
    const onPick = open();
    const filter = screen.getByLabelText("Filter models");
    fireEvent.change(filter, { target: { value: "deepseek" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("switches to the model the filter actually left under the cursor", () => {
    const onPick = open();
    const filter = screen.getByLabelText("Filter models");
    fireEvent.change(filter, { target: { value: "deepseek" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    const [, model] = onPick.mock.calls[0];
    expect(String(model)).toContain("deepseek");
  });

  it("does not ask for the model already in use", () => {
    // Re-picking the current row is a no-op, not a rebuild of the session you are sitting in.
    const onPick = open();
    fireEvent.click(screen.getByRole("option", { name: /gpt-5\.6-luna/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers models from providers other than the configured one", () => {
    // The window holds one provider's credentials at a time, but switching provider is a legitimate
    // thing to do from here — a menu that hid the others would look like the app supported one.
    open();
    fireEvent.change(screen.getByLabelText("Filter models"), { target: { value: "claude" } });
    expect(screen.getAllByText(/Anthropic/).length).toBeGreaterThan(0);
  });

  it("cannot be opened while the tab is busy", () => {
    // Busy means a request for this tab is already in flight; switching model mid-flight would
    // rebuild the session underneath it.
    const onPick = vi.fn();
    render(
      <ModelPicker provider="circuitnotion" model="gpt-5.6-luna" busy onPick={onPick} open={false} onOpenChange={() => {}} />,
    );
    expect((screen.getByTitle(/Switch model/) as HTMLButtonElement).disabled).toBe(true);
  });
});
