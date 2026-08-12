import { describe, expect, it } from "vitest";
import { shouldFollow, splitSegments } from "./transcript";

describe("splitting an assistant message into prose and code", () => {
  it("separates a fenced block from the text around it", () => {
    const segments = splitSegments("Here you go:\n```ts\nconst a = 1;\n```\nThat's it.");
    expect(segments).toEqual([
      { kind: "text", text: "Here you go:" },
      { kind: "code", language: "ts", code: "const a = 1;" },
      { kind: "text", text: "That's it." },
    ]);
  });

  it("treats an unterminated fence as code, because streaming produces one every turn", () => {
    // Mid-stream the closing fence has not arrived yet. Reading that as prose would make code
    // flicker from unformatted to formatted as the last token lands.
    const segments = splitSegments("Writing it now:\n```py\nprint(1)");
    expect(segments[1]).toEqual({ kind: "code", language: "py", code: "print(1)" });
  });

  it("keeps a fence with no language, rather than dropping the block", () => {
    expect(splitSegments("```\nplain\n```")).toEqual([{ kind: "code", language: undefined, code: "plain" }]);
  });

  it("handles several blocks in one message", () => {
    const segments = splitSegments("one\n```\na\n```\ntwo\n```\nb\n```");
    expect(segments.filter((segment) => segment.kind === "code")).toHaveLength(2);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "code", "text", "code"]);
  });

  it("returns plain text untouched when there is no fence at all", () => {
    expect(splitSegments("just a sentence")).toEqual([{ kind: "text", text: "just a sentence" }]);
  });

  it("preserves indentation and blank lines inside a block", () => {
    // Code whose leading whitespace is normalised away is code you cannot paste back.
    const code = "def f():\n\n    return 1";
    expect(splitSegments(`\`\`\`py\n${code}\n\`\`\``)[0]).toEqual({ kind: "code", language: "py", code });
  });

  it("drops whitespace-only prose so an empty paragraph is never rendered", () => {
    expect(splitSegments("\n\n```\na\n```\n\n")).toEqual([{ kind: "code", language: undefined, code: "a" }]);
  });

  it("loses no content: every character is in some segment", () => {
    // The property that matters most — a parser that silently eats part of an answer is worse than
    // one that formats nothing.
    const message = "intro ``` not a fence\n```sh\necho hi\n```\ntail";
    const rebuilt = splitSegments(message).map((segment) => (segment.kind === "code" ? segment.code : segment.text)).join("");
    for (const token of ["intro", "echo hi", "tail"]) expect(rebuilt).toContain(token);
  });

  it("returns nothing for an empty message", () => {
    expect(splitSegments("")).toEqual([]);
    expect(splitSegments("   \n ")).toEqual([]);
  });
});

describe("deciding whether to follow new output", () => {
  it("follows when the reader is at the bottom", () => {
    expect(shouldFollow({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("stops following once the reader scrolls up", () => {
    // The bug this fixes: every new token yanked the view back down, so reading anything during a
    // turn was impossible.
    expect(shouldFollow({ scrollTop: 100, scrollHeight: 5000, clientHeight: 500 })).toBe(false);
  });

  it("tolerates a small gap, so a part-scrolled line does not detach the view", () => {
    expect(shouldFollow({ scrollTop: 860, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(shouldFollow({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("follows when there is nothing to scroll", () => {
    expect(shouldFollow({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(true);
  });
});
