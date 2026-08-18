import { describe, expect, it } from "vitest";
import {
  chordFromKeypress,
  chordId,
  formatChord,
  isLikelyDeliverable,
  KeyBindingRegistry,
  parseChord,
  resolveBindings,
  RELOCATED_EDITING,
  RESERVED_CHORDS,
} from "./keybindings";

describe("chords", () => {
  it("parses the spellings people actually write", () => {
    expect(chordId(parseChord("ctrl+g")!)).toBe("ctrl+g");
    expect(chordId(parseChord("  CTRL + G ")!)).toBe("ctrl+g");
    expect(chordId(parseChord("F4")!)).toBe("f4");
    expect(chordId(parseChord("control+shift+tab")!)).toBe("ctrl+shift+tab");
    expect(chordId(parseChord("option+p")!)).toBe("alt+p");
  });

  it("refuses a chord it only partly understands", () => {
    // Half-parsing "hyper+k" into "k" would bind a bare letter and eat typing.
    expect(parseChord("hyper+k")).toBeUndefined();
    expect(parseChord("f13")).toBeUndefined();
    expect(parseChord("ctrl+")).toBeUndefined();
    expect(parseChord("")).toBeUndefined();
  });

  it("renders a chord the way a keyboard is labelled", () => {
    expect(formatChord(parseChord("ctrl+g")!)).toBe("Ctrl+G");
    expect(formatChord(parseChord("f4")!)).toBe("F4");
    expect(formatChord(parseChord("ctrl+shift+tab")!)).toBe("Ctrl+Shift+Tab");
  });

  it("reads readline's keypress events", () => {
    expect(chordId(chordFromKeypress({ name: "g", ctrl: true })!)).toBe("ctrl+g");
    expect(chordFromKeypress({ sequence: "" })).toBeUndefined();
  });
});

describe("resolving bindings", () => {
  it("binds the defaults, and every editing key it took has somewhere else to live", () => {
    const { bindings, conflicts, displaced } = resolveBindings();
    expect(conflicts).toEqual([]);
    expect(bindings.map((binding) => binding.command)).toContain("/palette");
    // The invariant that replaced "never touch a reserved chord": a default may take a line-editing
    // key, but only one `RELOCATED_EDITING` names a replacement for. A binding that eats an editing
    // action with nowhere for it to go is the failure this guards.
    for (const binding of bindings) {
      const id = chordId(binding.chord);
      if (RESERVED_CHORDS[id]) expect(RELOCATED_EDITING[id]).toBeDefined();
    }
    // And whatever was taken is reported, so `/keys` can say where it went.
    expect(displaced.map((entry) => entry.chord).sort()).toEqual(["Ctrl+A", "Ctrl+W"]);
    expect(displaced.find((entry) => entry.chord === "Ctrl+A")).toMatchObject({ command: "/auto", instead: "Home" });
  });

  it("refuses a line-editing key that has no replacement", () => {
    // Ctrl+K and Ctrl+U are readline editing actions with nothing else that does their job — no
    // named key deletes to the end or the start of a line. Shadowing them breaks typing in a way
    // that looks like a bug in the terminal, so the registry declines and names what it would eat.
    const { bindings, conflicts } = resolveBindings({ "/palette": "ctrl+k", "/todos": "ctrl+u" });
    expect(bindings.some((binding) => binding.command === "/palette")).toBe(false);
    expect(conflicts).toContainEqual({ command: "/palette", chord: "Ctrl+K", reason: "reserved for line editing (delete to end of line)" });
    expect(conflicts).toContainEqual({ command: "/todos", chord: "Ctrl+U", reason: "reserved for line editing (delete to start of line)" });
  });

  it("refuses the keys that are the way out, whatever the configuration says", () => {
    const { conflicts } = resolveBindings({ "/diff": "ctrl+c", "/todos": "enter" });
    expect(conflicts).toContainEqual({ command: "/diff", chord: "Ctrl+C", reason: "reserved for line editing (interrupt the current turn)" });
    expect(conflicts).toContainEqual({ command: "/todos", chord: "Enter", reason: "reserved for line editing (submit)" });
  });

  it("refuses a chord the terminal cannot send as its own key, and says why", () => {
    // Not policy: Ctrl+M is byte 0x0D, which is what Return sends. Binding it would bind Enter.
    const { bindings, conflicts } = resolveBindings({ "/model": "ctrl+m" });
    expect(bindings.some((binding) => binding.command === "/model")).toBe(false);
    expect(conflicts).toContainEqual({
      command: "/model",
      chord: "Ctrl+M",
      reason: "the same byte as Enter (0x0D) — terminals cannot tell them apart",
    });
  });

  it("refuses two commands on one chord instead of picking a winner", () => {
    const { conflicts } = resolveBindings({ "/diff": "f2" });
    // F2 is /mode by default. Whichever loses, the user must be told which key does what.
    expect(conflicts.some((conflict) => conflict.reason.startsWith("already bound to"))).toBe(true);
  });

  it("reports a chord it cannot parse rather than ignoring the line", () => {
    expect(resolveBindings({ "/diff": "squiggle" }).conflicts[0]).toMatchObject({ command: "/diff", reason: expect.stringContaining("not a key I understand") });
  });

  it("reports a binding for a command that does not exist", () => {
    expect(resolveBindings({ "/nope": "f7" }).conflicts[0]).toMatchObject({ command: "/nope", reason: "no such command" });
  });

  it("lets a binding be turned off without parking it on a spare key", () => {
    const { bindings, conflicts } = resolveBindings({ "/wander": "off" });
    expect(bindings.some((binding) => binding.command === "/wander")).toBe(false);
    expect(conflicts).toEqual([]);
  });

  it("binds a command that carries arguments", () => {
    // "/tab next" is one action from the user's point of view; only "/tab" has to be a real command.
    const { bindings, conflicts } = resolveBindings();
    expect(conflicts).toEqual([]);
    expect(bindings.find((binding) => binding.command === "/tab next")?.chord.key).toBe("right");
    expect(resolveBindings({ "/nope next": "f7" }).conflicts[0]).toMatchObject({ reason: "no such command" });
  });

  it("rebinds a command to a free chord", () => {
    const { bindings, conflicts } = resolveBindings({ "/diff": "alt+d" });
    expect(conflicts).toEqual([]);
    expect(bindings.find((binding) => binding.command === "/diff")?.chord).toEqual({ key: "d", ctrl: false, shift: false, meta: true });
  });
});

describe("terminal capability", () => {
  it("distrusts the chords terminals are known to swallow", () => {
    expect(isLikelyDeliverable(parseChord("f4")!, { TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(false);
    expect(isLikelyDeliverable(parseChord("ctrl+shift+tab")!)).toBe(false);
    expect(isLikelyDeliverable(parseChord("f4")!, {})).toBe(true);
    expect(isLikelyDeliverable(parseChord("ctrl+g")!, { TERM: "dumb" })).toBe(false);
  });
});

describe("the registry", () => {
  it("matches a bound key and ignores everything else", () => {
    const registry = new KeyBindingRegistry();
    expect(registry.match({ name: "g", ctrl: true })).toBe("/palette");
    expect(registry.match({ name: "f2" })).toBe("/mode");
    // The Ctrl layer, which is the point of having one: the three commands people reach for most
    // are one keypress away on the modifier terminals deliver most reliably.
    expect(registry.match({ name: "a", ctrl: true })).toBe("/auto");
    expect(registry.match({ name: "w", ctrl: true })).toBe("/wander");
    expect(registry.match({ name: "s", ctrl: true })).toBe("/settings");
    // An unbound key must fall through to readline, or ordinary typing stops working. A bare letter
    // above all: this prompt is where free text is typed.
    expect(registry.match({ name: "a" })).toBeUndefined();
    expect(registry.match({ name: "w" })).toBeUndefined();
    // Ctrl+M arrives as Enter, so it can never match — binding it would fire on every submitted
    // message. `resolveBindings` refuses it; this is the other end of the same guarantee.
    expect(registry.match({ name: "return", ctrl: false })).toBeUndefined();
  });

  it("points at the slash command when the terminal may not deliver the key", () => {
    const rendered = new KeyBindingRegistry({}, { TMUX: "1" }).render();
    expect(rendered).toContain("this terminal may not send it; use /mode");
    expect(rendered).toContain("Feature keys");
  });

  it("says where displaced line editing went, so a missing key is never a mystery", () => {
    // The question someone arrives with is "how do I get to the start of the line now", so the row
    // leads with the answer rather than with what was taken.
    const rendered = new KeyBindingRegistry().render();
    expect(rendered).toContain("Line editing that moved");
    expect(rendered).toContain("Home");
    expect(rendered).toContain("Ctrl+A runs /auto now");
    expect(rendered).toContain("Alt+Backspace");
  });

  it("shows what it refused to bind, so a dead key is never silent", () => {
    const rendered = new KeyBindingRegistry({ "/todos": "ctrl+u" }).render();
    expect(rendered).toContain("Not bound");
    expect(rendered).toContain("reserved for line editing");
  });
});

describe("mnemonic letter shortcuts", () => {
  it("puts the letters on Alt, never bare, so every letter stays typeable at the prompt", () => {
    // The prompt is where free text is entered. A bare `w` for /wander costs you every message
    // beginning with "write", and restricting it to an empty line does not help — an empty line is
    // exactly where "write a test" begins.
    const { bindings } = resolveBindings();
    for (const binding of bindings) {
      if (binding.chord.key.length === 1) {
        expect(binding.chord.meta || binding.chord.ctrl, `${binding.chord.key} must carry a modifier`).toBe(true);
      }
    }
  });

  it("binds the mnemonics asked for: w wander, m model, a auto", () => {
    const byCommand = new Map(resolveBindings().bindings.map((b) => [chordId(b.chord), b.command]));
    expect(byCommand.get("alt+w")).toBe("/wander");
    expect(byCommand.get("alt+m")).toBe("/model");
    expect(byCommand.get("alt+a")).toBe("/auto");
  });

  it("keeps the function keys alongside the letters, so neither is the only route", () => {
    const chords = resolveBindings().bindings.filter((b) => b.command === "/wander").map((b) => chordId(b.chord));
    expect(chords).toContain("f4");
    expect(chords).toContain("alt+w");
  });

  it("lets an override replace every default chord, rather than adding a third", () => {
    // "I want /diff on Alt+X" must not leave F8 and Alt+D quietly live as well.
    const chords = resolveBindings({ "/diff": "alt+x" }).bindings.filter((b) => b.command === "/diff").map((b) => chordId(b.chord));
    expect(chords).toEqual(["alt+x"]);
  });

  it("still honours off for a command that has several defaults", () => {
    expect(resolveBindings({ "/wander": "off" }).bindings.some((b) => b.command === "/wander")).toBe(false);
  });

  it("assigns no chord twice, across the whole default table", () => {
    const { bindings, conflicts } = resolveBindings();
    const ids = bindings.map((b) => chordId(b.chord));
    expect(new Set(ids).size).toBe(ids.length);
    expect(conflicts).toEqual([]);
  });

  it("groups a command's keys onto one line in /keys instead of repeating it", () => {
    const rendered = new KeyBindingRegistry({}, { TERM: "xterm-256color" }).render();
    expect(rendered).toContain("F4, Alt+W");
    expect(rendered.match(/Run a bounded research exploration/g)).toHaveLength(1);
  });

  it("gives shortcutLabels the same grouped chords render() shows, in the compact form /help inlines", () => {
    const labels = new KeyBindingRegistry().shortcutLabels();
    expect(labels.get("/wander")).toBe("Ctrl+W, F4, Alt+W");
    expect(labels.get("/mode")).toBe("F2");
  });

  it("says nothing about deliverability in shortcutLabels — that caveat stays exclusive to /keys", () => {
    const labels = new KeyBindingRegistry({}, { TMUX: "1" }).shortcutLabels();
    expect(labels.get("/mode")).toBe("F2");
    expect(labels.get("/mode")).not.toContain("may not send");
  });

  it("omits a command entirely from shortcutLabels once every chord for it is turned off", () => {
    const labels = new KeyBindingRegistry({ "/wander": "off" }).shortcutLabels();
    expect(labels.has("/wander")).toBe(false);
  });
});
