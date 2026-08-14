import { describe, expect, it } from "vitest";
import { COMMANDS } from "./commands";
import { ASCII_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import {
  GUIDE_TOPICS,
  documentedCommands,
  findTopic,
  parseGuideCommand,
  renderGuideIndex,
  renderGuideTopic,
  renderWholeGuide,
  searchTopics,
  undocumentedCommands,
  wrapText,
} from "./guide";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 80): SectionStyle => ({ width, depth: "none" });

describe("what the guide covers", () => {
  it("documents every command that exists — the check that stops it going stale", () => {
    // A command added without a line in the guide fails here, which is the only mechanism that has
    // ever kept documentation honest.
    expect(undocumentedCommands()).toEqual([]);
  });

  it("does not claim to document a command that does not exist", () => {
    const registered = new Set<string>(COMMANDS.map((command) => command.name));
    const invented = [...documentedCommands()].filter((name) => !registered.has(name));
    expect(invented).toEqual([]);
  });

  it("gives every topic an id, a title, a summary and something to read", () => {
    for (const topic of GUIDE_TOPICS) {
      expect(topic.id, topic.title).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(topic.title).not.toBe("");
      expect(topic.summary).not.toBe("");
      expect(topic.body.length, `${topic.id} body`).toBeGreaterThan(0);
    }
  });

  it("has no two topics with the same id, since an id is how one is asked for", () => {
    const ids = GUIDE_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("starts with the topic a new user needs first", () => {
    expect(GUIDE_TOPICS[0].id).toBe("start");
  });

  it("shows a runnable example for the things that are commands", () => {
    // Prose alone leaves the reader to guess the syntax; every topic that documents a command
    // carries at least one line they can type verbatim.
    for (const topic of GUIDE_TOPICS) {
      if (topic.covers.length === 0) continue;
      expect(topic.examples?.length ?? 0, `${topic.id} examples`).toBeGreaterThan(0);
    }
  });
});

describe("finding a topic", () => {
  it("takes an id, or a word from the title", () => {
    expect(findTopic("tabs")?.id).toBe("tabs");
    expect(findTopic("Memory")?.id).toBe("memory");
    expect(findTopic("control panel")?.id).toBe("panel");
  });

  it("returns nothing for a topic that does not exist, rather than the nearest one", () => {
    expect(findTopic("quantum")).toBeUndefined();
  });

  it("searches the body, not just the titles, because that is what people remember", () => {
    expect(searchTopics("sandbox").map((topic) => topic.id)).toContain("where");
    expect(searchTopics("scrollback").length).toBeGreaterThan(0);
    expect(searchTopics("")).toHaveLength(GUIDE_TOPICS.length);
    expect(searchTopics("kubernetes")).toEqual([]);
  });
});

describe("wrapping", () => {
  it("breaks on words and never mid-word", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("emits a word longer than the measure whole rather than hyphenating a command", () => {
    expect(wrapText("run /tab new sandbox --model claude-sonnet-5", 20).some((line) => line.includes("claude-sonnet-5"))).toBe(true);
  });

  it("returns nothing for nothing", () => {
    expect(wrapText("   ", 40)).toEqual([]);
  });
});

describe("reading it", () => {
  it("lists every topic in the index, with the way to open one", () => {
    const rendered = plain(renderGuideIndex(style()));
    for (const topic of GUIDE_TOPICS) expect(rendered, topic.id).toContain(topic.id);
    expect(rendered).toContain("/guide <topic>");
  });

  it("shows a topic's prose and its examples", () => {
    const rendered = plain(renderGuideTopic(findTopic("tabs")!, style()));
    expect(rendered).toContain("Tabs");
    expect(rendered).toContain("/tab new fast --model");
    expect(rendered).toContain("its own model");
  });

  it("points at the next topic, so it can be read straight through", () => {
    const rendered = plain(renderGuideTopic(GUIDE_TOPICS[0], style()));
    expect(rendered).toContain(`/guide ${GUIDE_TOPICS[1].id}`);
    // The last topic has nowhere to point, and must not invent one.
    expect(plain(renderGuideTopic(GUIDE_TOPICS[GUIDE_TOPICS.length - 1], style()))).not.toContain("next: /guide undefined");
  });

  it("stays inside the terminal at every width, which is the one thing prose gets wrong", () => {
    for (const width of [40, 60, 80, 120]) {
      const rendered = plain(renderWholeGuide({ width, depth: "none", glyphs: ASCII_GLYPHS }));
      for (const line of rendered.split("\n")) {
        expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders the whole thing for someone who wants to read or pipe it", () => {
    const rendered = plain(renderWholeGuide(style()));
    for (const topic of GUIDE_TOPICS) expect(rendered, topic.title).toContain(topic.title);
  });
});

describe("the /guide grammar", () => {
  it("opens the index on a bare command, under either name", () => {
    expect(parseGuideCommand("/guide")).toEqual({ kind: "index" });
    expect(parseGuideCommand("/tutorial")).toEqual({ kind: "index" });
  });

  it("takes a topic with no verb, which is how it will be typed", () => {
    expect(parseGuideCommand("/guide tabs")).toEqual({ kind: "topic", id: "tabs" });
    expect(parseGuideCommand("/guide control panel")).toEqual({ kind: "topic", id: "panel" });
  });

  it("searches and shows everything", () => {
    expect(parseGuideCommand("/guide search sandbox")).toEqual({ kind: "search", query: "sandbox" });
    expect(parseGuideCommand("/guide all")).toEqual({ kind: "all" });
  });

  it("says a topic is unknown rather than quietly showing the index", () => {
    // An index printed for a typo looks exactly like the command not working.
    expect(parseGuideCommand("/guide tabss")).toEqual({ kind: "unknown", id: "tabss" });
  });

  it("ignores anything that is not the command", () => {
    expect(parseGuideCommand("/guidelines")).toBeNull();
    expect(parseGuideCommand("guide me")).toBeNull();
  });
});
