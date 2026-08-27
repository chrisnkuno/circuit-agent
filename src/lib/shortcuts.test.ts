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
    expect(matchShortcut({ key: "g", ctrlKey: true })).toBe("palette");
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
      matchShortcut({ key: "F1" }),
      matchShortcut({ key: "/", ctrlKey: true }),
      matchShortcut({ key: "m", ctrlKey: true }),
      matchShortcut({ key: "g", ctrlKey: true }),
      matchShortcut({ key: "d", ctrlKey: true }),
      matchShortcut({ key: "p", ctrlKey: true }),
      matchShortcut({ key: "z", ctrlKey: true }),
      matchShortcut({ key: ",", ctrlKey: true }),
      matchShortcut({ key: "1", altKey: true }),
      matchShortcut({ key: "2", altKey: true }),
      matchShortcut({ key: "3", altKey: true }),
      matchShortcut({ key: "4", altKey: true }),
      matchShortcut({ key: "t", ctrlKey: true }),
      matchShortcut({ key: "w", ctrlKey: true }),
      matchShortcut({ key: "Tab", ctrlKey: true }),
      matchShortcut({ key: "Tab", ctrlKey: true, shiftKey: true }),
      matchShortcut({ key: "1", ctrlKey: true }),
    ]);
    for (const action of produced) expect(documented).toContain(action);
    expect(documented.size).toBe(produced.size);
  });

  it("covers the whole Ctrl+1…9 family with the one row that documents it", () => {
    // The matcher produces nine distinct actions here and the list carries a single row for them,
    // which is right — nine rows saying the same thing is a help panel nobody reads. What must hold
    // is that every one of the nine is reachable and none of them is a surprise.
    const produced = Array.from({ length: 9 }, (_, index) => matchShortcut({ key: String(index + 1), ctrlKey: true }));
    expect(produced).toEqual(Array.from({ length: 9 }, (_, index) => `tab-select-${index + 1}`));
    expect(SHORTCUTS.filter((binding) => binding.action.startsWith("tab-select"))).toHaveLength(1);
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

/**
 * Tabs took four chords that every tabbed application already owns, so the only interesting
 * questions are about the boundaries: what happens while someone is typing, and what must *not*
 * become a tab switch.
 */
describe("tab shortcuts", () => {
  it("uses the chords every tabbed application already uses", () => {
    expect(matchShortcut({ key: "t", ctrlKey: true })).toBe("tab-new");
    expect(matchShortcut({ key: "w", ctrlKey: true })).toBe("tab-close");
    expect(matchShortcut({ key: "Tab", ctrlKey: true })).toBe("tab-next");
    expect(matchShortcut({ key: "Tab", ctrlKey: true, shiftKey: true })).toBe("tab-previous");
    expect(matchShortcut({ key: "3", ctrlKey: true })).toBe("tab-select-3");
  });

  it("works on the Mac modifier too", () => {
    expect(matchShortcut({ key: "t", metaKey: true })).toBe("tab-new");
    expect(matchShortcut({ key: "1", metaKey: true })).toBe("tab-select-1");
  });

  it("still opens a tab for someone in the middle of typing", () => {
    // Unlike the letter shortcuts, these are claimed while typing: Ctrl+T is not a character, and
    // the person mid-sentence in one tab is exactly the person who wants to start another.
    expect(matchShortcut({ key: "t", ctrlKey: true, typing: true })).toBe("tab-new");
    expect(matchShortcut({ key: "Tab", ctrlKey: true, typing: true })).toBe("tab-next");
  });

  it("leaves a bare letter, digit or Tab alone, so prose and focus still work", () => {
    expect(matchShortcut({ key: "t" })).toBeUndefined();
    expect(matchShortcut({ key: "3" })).toBeUndefined();
    // Bare Tab has to keep moving focus, which is the only way the window is navigable by keyboard.
    expect(matchShortcut({ key: "Tab" })).toBeUndefined();
  });

  it("does not read a shifted number row as a tab switch", () => {
    // Some layouts produce punctuation from Ctrl+Shift+number; selecting a tab from that would be
    // a switch nobody asked for.
    expect(matchShortcut({ key: "3", ctrlKey: true, shiftKey: true })).toBeUndefined();
  });

  it("does not collide with the mode shortcuts on Alt", () => {
    expect(matchShortcut({ key: "1", altKey: true })).toBe("plan");
    expect(matchShortcut({ key: "t", ctrlKey: true, altKey: true })).toBeUndefined();
  });

  it("lists the tab keys in the help panel, since a shortcut nobody can find is not a feature", () => {
    const listed = SHORTCUTS.map((binding) => binding.action);
    expect(listed).toContain("tab-new");
    expect(listed).toContain("tab-close");
    expect(listed).toContain("tab-next");
  });
});


describe("reaching the project's files", () => {
  it("opens the explorer on the chord editors already use", () => {
    expect(matchShortcut({ key: "p", ctrlKey: true })).toBe("files");
  });

  it("leaves a typed p alone", () => {
    // Every letter shortcut has to survive this: the composer is the main thing on screen.
    expect(matchShortcut({ key: "p", typing: true })).toBeUndefined();
  });

  it("is listed, so it can be found without being told", () => {
    expect(SHORTCUTS.some((binding) => binding.action === "files")).toBe(true);
  });
});

describe("opening the guide", () => {
  it("answers F1, the key every application uses for help", () => {
    expect(matchShortcut({ key: "F1" })).toBe("guide");
  });

  it("answers F1 even mid-sentence", () => {
    // Unlike the letter shortcuts: F1 is not a character on any layout, and "how does this work"
    // is a question people have precisely while they are typing.
    expect(matchShortcut({ key: "F1", typing: true })).toBe("guide");
  });
});
