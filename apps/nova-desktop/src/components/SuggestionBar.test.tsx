/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SuggestionBar } from "./SuggestionBar";
import type { Suggestion } from "../lib/suggestions";

afterEach(cleanup);

const review: Suggestion = {
  id: "review-diff",
  label: "See what changed",
  reason: "3 files changed and not looked at yet",
  category: "next",
  action: { kind: "ui", id: "open-diff" },
};

const recover: Suggestion = {
  id: "recover-auth",
  label: "Check the API key",
  reason: "the provider rejected the key",
  category: "recovery",
  action: { kind: "ui", id: "open-settings" },
};

describe("the suggestion bar", () => {
  it("takes no room at all when there is nothing to suggest", () => {
    // The bar comes and goes with the situation. A permanently present strip teaches the reader
    // there is nothing in it.
    const { container } = render(<SuggestionBar suggestions={[]} onTake={() => {}} />);
    expect(container.querySelector(".suggestion-bar")).toBeNull();
  });

  it("hands back the suggestion that was clicked, not merely that one was", () => {
    const onTake = vi.fn();
    render(<SuggestionBar suggestions={[review, recover]} onTake={onTake} />);
    fireEvent.click(screen.getByRole("button", { name: /Check the API key/ }));
    expect(onTake).toHaveBeenCalledWith(recover);
  });

  it("marks a way out of a failure as something other than advice", () => {
    render(<SuggestionBar suggestions={[review, recover]} onTake={() => {}} />);
    expect(screen.getByRole("button", { name: /See what changed/ }).className).toContain("next");
    expect(screen.getByRole("button", { name: /Check the API key/ }).className).toContain("recovery");
  });

  it("marks a model's guess as a guess", () => {
    render(<SuggestionBar suggestions={[{ ...review, fromModel: true }]} onTake={() => {}} />);
    expect(screen.getByLabelText("suggested by the model")).toBeTruthy();
  });

  it("names the group, so a screen reader reaches a row of buttons that says what it is", () => {
    render(<SuggestionBar suggestions={[review]} onTake={() => {}} label="Try this" />);
    expect(screen.getByRole("group", { name: "Try this" })).toBeTruthy();
  });

  it("carries the reason with the chip rather than leaving it a button that appeared for no cause", () => {
    render(<SuggestionBar suggestions={[review]} onTake={() => {}} />);
    // Radix mounts the tooltip's content on hover/focus; the trigger is described by it either way.
    fireEvent.focus(screen.getByRole("button", { name: /See what changed/ }));
    expect(screen.getAllByText(review.reason).length).toBeGreaterThan(0);
  });
});
