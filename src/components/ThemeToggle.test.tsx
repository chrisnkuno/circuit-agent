/**
 * @vitest-environment happy-dom
 *
 * As in `TabStrip.test.tsx`: the repo-wide vitest run has no DOM preload, so this file asks for one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY } from "../lib/theme";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // happy-dom answers every media query with `matches: false`, which is "the machine prefers
  // light" — the same answer a machine with no preference gives.
});

/**
 * Radix opens a menu on pointer-down, not on click — the same as a native menu bar, where the list
 * is up before the button is released. Firing a click alone leaves it closed.
 */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /Appearance/ }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("the appearance control", () => {
  it("themes the document before anyone interacts with it", () => {
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("offers all three, because 'follow the machine' is not expressible as a switch", () => {
    render(<ThemeToggle />);
    openMenu();
    expect(screen.getByRole("menuitemradio", { name: /Light/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Dark/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /System/ })).toBeTruthy();
  });

  it("applies a choice to the document and remembers it", () => {
    render(<ThemeToggle />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Dark/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("opens on the choice that was stored, not on a default", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    openMenu();
    expect(screen.getByRole("menuitemradio", { name: /Dark/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("says what 'System' currently resolves to, since that row is the ambiguous one", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    render(<ThemeToggle />);
    openMenu();
    expect(screen.getByRole("menuitemradio", { name: /System/ }).textContent).toContain("light");
  });

  it("tells whoever is listening what it resolved to", () => {
    const seen: string[] = [];
    render(<ThemeToggle onResolved={(resolved) => seen.push(resolved)} />);
    expect(seen).toContain("light");
  });
});
