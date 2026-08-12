import { describe, expect, it } from "vitest";
import { SHORTCUTS, isTypingTarget, matchShortcut } from "./shortcuts";

describe("matching a keypress to an action", () => {
  it("sends on Ctrl+Enter and on Cmd+Enter", () => {
    // The same binding has to work on macOS, where the modifier is Meta.
    expect(matchShortcut({ key: "Enter", ctrlKey: true })).toBe("send");
    expect(matchShortcut({ key: "Enter", metaKey: true })).toBe("send");
  });

  it("leaves a bare Enter alone, so the composer keeps its newline", () => {
    expect(matchShortcut({ key: "Enter" })).toBeUndefined();
  });

  it("stops the turn on Escape, but not while typing", () => {
    // Stopping a runaway turn must not require aiming a mouse; typing Escape in the composer
    // should not kill the turn the user is describing.
    expect(matchShortcut({ key: "Escape" })).toBe("stop");
    expect(matchShortcut({ key: "Escape", typing: true })).toBeUndefined();
  });

  it("requires a modifier for every letter shortcut", () => {
    // The composer is the main thing on screen; a bare letter has to stay a letter.
    for (const key of ["m", "d", "z", "/"]) {
      expect(matchShortcut({ key })).toBeUndefined();
      expect(matchShortcut({ key, typing: true })).toBeUndefined();
    }
    expect(matchShortcut({ key: "m", ctrlKey: true })).toBe("models");
    expect(matchShortcut({ key: "d", ctrlKey: true })).toBe("diff");
    expect(matchShortcut({ key: "z", ctrlKey: true })).toBe("undo");
    expect(matchShortcut({ key: "/", ctrlKey: true })).toBe("focus-composer");
    expect(matchShortcut({ key: ",", ctrlKey: true })).toBe("settings");
  });

  it("switches mode on Alt with a digit", () => {
    expect(matchShortcut({ key: "1", altKey: true })).toBe("plan");
    expect(matchShortcut({ key: "2", altKey: true })).toBe("build");
    expect(matchShortcut({ key: "3", altKey: true })).toBe("auto");
  });

  it("does not fire a mode switch on a plain digit typed into the composer", () => {
    expect(matchShortcut({ key: "1", typing: true })).toBeUndefined();
    expect(matchShortcut({ key: "2" })).toBeUndefined();
  });

  it("ignores combinations that add a modifier the binding does not use", () => {
    // Ctrl+Alt+D is a different chord, often the platform's; claiming it would be rude and wrong.
    expect(matchShortcut({ key: "d", ctrlKey: true, altKey: true })).toBeUndefined();
    expect(matchShortcut({ key: "1", altKey: true, ctrlKey: true })).toBeUndefined();
  });

  it("is case-insensitive, so caps lock does not disable the app", () => {
    expect(matchShortcut({ key: "D", ctrlKey: true })).toBe("diff");
    expect(matchShortcut({ key: "ESCAPE" })).toBe("stop");
  });

  it("returns nothing for keys it does not claim", () => {
    expect(matchShortcut({ key: "k", ctrlKey: true })).toBeUndefined();
    expect(matchShortcut({ key: "Tab" })).toBeUndefined();
    expect(matchShortcut({ key: "ArrowUp", ctrlKey: true })).toBeUndefined();
  });
});

describe("the documented list", () => {
  it("documents every action the matcher can produce", () => {
    // A shortcut that exists but is not listed is a shortcut nobody finds.
    const documented = new Set(SHORTCUTS.map((binding) => binding.action));
    const produced = new Set([
      matchShortcut({ key: "Enter", ctrlKey: true }),
      matchShortcut({ key: "Escape" }),
      matchShortcut({ key: "/", ctrlKey: true }),
      matchShortcut({ key: "m", ctrlKey: true }),
      matchShortcut({ key: "d", ctrlKey: true }),
      matchShortcut({ key: "z", ctrlKey: true }),
      matchShortcut({ key: ",", ctrlKey: true }),
      matchShortcut({ key: "1", altKey: true }),
      matchShortcut({ key: "2", altKey: true }),
      matchShortcut({ key: "3", altKey: true }),
    ]);
    for (const action of produced) expect(documented).toContain(action);
    expect(documented.size).toBe(produced.size);
  });

  it("binds each action exactly once", () => {
    const actions = SHORTCUTS.map((binding) => binding.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe("recognising a text field", () => {
  it("knows the elements a person types into", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("does not mistake ordinary elements, or nothing at all, for a text field", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});
